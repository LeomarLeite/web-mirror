/**
 * WebMirror — servidor HTTP + motor de captura + empacotamento.
 *
 * Fluxo: POST /api/capture recebe uma URL pública → a captura entra numa fila → o Chromium
 * headless (Playwright) renderiza a página, guarda CSS/JS/imagens/fontes e troca vídeos e
 * áudios locais por respostas vazias → o HTML final é reescrito com caminhos relativos
 * (./assets/...) → tudo vira um .zip em DOWNLOAD_DIR, baixado por GET /download/:id.
 *
 * Conversa com: express (API e tela), playwright (navegador), archiver (zip) e o sistema de
 * arquivos (uma pasta temporária por captura em WORK_DIR e a pasta de downloads, que no
 * Docker é um volume). Não acessa áreas logadas: cada captura abre um contexto limpo, sem
 * cookies, e o navegador se identifica como headless.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ZipArchive } from 'archiver';
import express from 'express';
import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// Configuração (tudo por variável de ambiente, igual com e sem Docker)
// ---------------------------------------------------------------------------

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = '0.1.0';

/** Lê um inteiro não negativo do ambiente; usa o padrão quando ausente ou inválido. */
function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Lê um booleano do ambiente (true/1/yes/sim); usa o padrão quando ausente. */
function envBool(name, fallback) {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'sim'].includes(value);
}

const MB = 1024 * 1024;

const CONFIG = Object.freeze({
  port: envInt('PORT', 3000),
  downloadDir: path.resolve(process.env.DOWNLOAD_DIR || path.join(APP_DIR, 'downloads')),
  workDir: path.resolve(process.env.WORK_DIR || path.join(os.tmpdir(), 'webmirror')),
  maxZipBytes: envInt('MAX_ZIP_SIZE_MB', 50) * MB,
  maxAssetBytes: envInt('MAX_ASSET_SIZE_MB', 5) * MB,
  maxAssets: envInt('MAX_ASSETS', 1500),
  maxConcurrentJobs: Math.max(1, envInt('MAX_CONCURRENT_JOBS', 2)),
  maxQueuedJobs: envInt('MAX_QUEUED_JOBS', 20),
  navigationTimeoutMs: envInt('NAVIGATION_TIMEOUT_MS', 45_000),
  networkIdleTimeoutMs: envInt('NETWORK_IDLE_TIMEOUT_MS', 15_000),
  jobTimeoutMs: envInt('JOB_TIMEOUT_MS', 180_000),
  zipRetentionMs: envInt('ZIP_RETENTION_HOURS', 24) * 3_600_000,
  allowPrivateNetworks: envBool('ALLOW_PRIVATE_NETWORKS', false),
  viewport: { width: 1440, height: 900 },
  // Modo interativo: liga o endpoint que abre uma janela visível para o usuário passar por
  // verificações (ex.: Cloudflare) e só então capturar. Precisa de tela: use rodando a app
  // direto na sua máquina (npm start), não dentro do container (sem display por padrão).
  interactiveEnabled: envBool('INTERACTIVE_ENABLED', true),
  // Pasta do perfil do navegador do modo interativo: guarda cookies/estado para não refazer
  // a verificação a cada captura. Um perfil só, usado por uma sessão de cada vez.
  profileDir: path.resolve(process.env.PROFILE_DIR || path.join(os.tmpdir(), 'webmirror-profile')),
  // Tempo que a janela interativa fica aberta esperando o usuário antes de desistir sozinha.
  interactiveIdleTimeoutMs: envInt('INTERACTIVE_IDLE_TIMEOUT_MS', 300_000),
});

/** Domínios cujos vídeos e iframes ficam apontando para o original (streaming online). */
const EMBED_HOSTS = Object.freeze([
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'ytimg.com',
  'googlevideo.com',
  'vimeo.com',
  'vimeocdn.com',
  ...(process.env.EMBED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
]);

/** Tipo de recurso do navegador → subpasta dentro de assets/. Outros tipos não são baixados. */
const ASSET_FOLDERS = Object.freeze({
  stylesheet: 'css',
  script: 'js',
  image: 'img',
  font: 'fonts',
});

/** Extensões que indicam vídeo/stream mesmo quando o navegador não marca o pedido como "media". */
const VIDEO_EXTENSION_RE = /\.(mp4|webm|mov|m4v|ogv|avi|mkv|flv|wmv|m3u8|mpd)$/i;

/** Extensão pelo Content-Type, para arquivos cuja URL não tem extensão (ex.: /imagem?id=3). */
const EXTENSION_BY_MIME = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff': '.woff',
  'application/font-woff2': '.woff2',
  'application/x-font-ttf': '.ttf',
});

/*
 * Padrões de url(...) e @import "..." no CSS. Ficam como texto porque são usados nos dois
 * lados: aqui no Node (arquivos .css) e dentro do navegador (<style> e atributos style).
 */
const CSS_URL_PATTERN = String.raw`url\(\s*(['"]?)([^'")]+)\1\s*\)`;
const CSS_IMPORT_PATTERN = String.raw`@import\s+(['"])([^'"]+)\1`;

const PLACEHOLDER_PATH = 'assets/webmirror/midia-removida.svg';
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#1f2937"/>
  <circle cx="640" cy="320" r="70" fill="none" stroke="#9ca3af" stroke-width="8"/>
  <path d="M615 285 L615 355 L675 320 Z" fill="#9ca3af"/>
  <text x="640" y="450" fill="#e5e7eb" font-family="sans-serif" font-size="34" text-anchor="middle">Mídia removida para estudo offline</text>
  <text x="640" y="500" fill="#9ca3af" font-family="sans-serif" font-size="22" text-anchor="middle">URL original no atributo data-webmirror-src</text>
</svg>
`;

// Vídeo de exemplo embutido no app: entra no .zip quando o vídeo original é restrito (ver extensão).
const EXAMPLE_VIDEO_PATH = 'assets/webmirror/exemplo-webmirror.mp4';
const EXAMPLE_VIDEO_FILE = path.join(APP_DIR, 'server-assets', 'exemplo-webmirror.mp4');

// Regras para classificar a fonte de um vídeo (ver classifyMediaUrlNode).
const STREAM_MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i; // HLS/DASH: segmentos normalmente assinados
const SIGNED_URL_RE = /[?&](?:token|signature|sign|expires?|expiry|policy|key[-_]?pair[-_]?id|x-amz-[a-z-]+|hdnts|__token__|jwt|auth|hmac|md5)=/i;

/** Domínio de embed público (YouTube/Vimeo etc., ver EMBED_HOSTS)? */
function isEmbedHostUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return EMBED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Decide, no servidor, o que fazer com a fonte de um vídeo:
 *  - 'public'  : abre de qualquer lugar → mantém o embed do original (online).
 *  - 'example' : assinado/streaming, ou que exige domínio/IP/login (ex.: Vimeo restrito) → vídeo de exemplo.
 *
 * A sondagem é feita SEM Referer nem cookies: se o vídeo não abre "de qualquer lugar", é restrito.
 * (O YouTube quase nunca restringe; o Vimeo pode liberar só para um domínio/host — e cai aqui.)
 */
async function classifyMediaUrlNode(url) {
  if (!/^https?:/i.test(url)) return 'example';
  if (isEmbedHostUrl(url)) return 'public'; // player do YouTube/Vimeo: fica online
  if (STREAM_MANIFEST_RE.test(url)) return 'example';
  if (SIGNED_URL_RE.test(url)) return 'example';
  let target;
  try {
    target = await validateTargetUrl(url); // bloqueia IP privado / SSRF
  } catch {
    return 'example';
  }
  try {
    const response = await fetch(target.href, { method: 'GET', headers: { Range: 'bytes=0-1' }, signal: AbortSignal.timeout(8000) });
    if (response.status === 401 || response.status === 403) return 'example'; // exige autenticação
    if (response.ok || response.status === 206) return 'public';
    return 'example';
  } catch {
    return 'example'; // rede/timeout: por segurança, trata como restrito
  }
}

/** Coleta as URLs de vídeo/áudio da página e classifica cada uma (público/restrito). */
async function classifyPageMedia(page) {
  const verdicts = {};
  let urls = [];
  try {
    urls = await page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll('video, audio').forEach((media) => {
        [media.getAttribute('src'), ...Array.from(media.querySelectorAll('source'), (s) => s.getAttribute('src'))]
          .filter(Boolean)
          .forEach((u) => {
            try {
              set.add(new URL(u, document.baseURI).href.split('#')[0]);
            } catch {
              /* ignora URL inválida */
            }
          });
      });
      return [...set];
    });
  } catch {
    return verdicts;
  }
  for (const url of urls) verdicts[url] = await classifyMediaUrlNode(url);
  return verdicts;
}

/**
 * Grava no pacote os assets internos do WebMirror que o HTML de fato referencia: o placeholder
 * SVG (modo automático/interativo) e/ou o vídeo de exemplo (extensão). Escreve só o que aparece
 * no HTML, então serve para qualquer modo sem precisar olhar contadores.
 */
async function writeInternalAssets(siteDir, html) {
  const refs = typeof html === 'string' ? html : '';
  const dir = path.join(siteDir, 'assets', 'webmirror');
  if (refs.includes(PLACEHOLDER_PATH)) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(siteDir, PLACEHOLDER_PATH), PLACEHOLDER_SVG, 'utf8');
  }
  if (refs.includes(EXAMPLE_VIDEO_PATH)) {
    await fsp.mkdir(dir, { recursive: true });
    try {
      await fsp.copyFile(EXAMPLE_VIDEO_FILE, path.join(siteDir, EXAMPLE_VIDEO_PATH));
    } catch {
      /* se o vídeo de exemplo faltar no app, não derruba a captura; só não inclui o arquivo */
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Erros e validação da URL de entrada
// ---------------------------------------------------------------------------

/** Erro com status HTTP; a mensagem é segura para mostrar ao usuário. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Diz se um IP é de rede privada, local, link-local, multicast ou reservado.
 * Usado para impedir que a ferramenta acesse a rede interna (ex.: 169.254.169.254, roteador).
 */
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(lower);
  }
  return true;
}

/** Checagem rápida (sem DNS) para os pedidos feitos pela página: localhost ou IP privado literal. */
function isPrivateHostLiteral(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return net.isIP(host) ? isPrivateAddress(host) : false;
}

/**
 * Valida a URL enviada pelo usuário: http/https, sem usuário/senha embutidos e, por padrão,
 * fora da rede privada (o domínio é resolvido no DNS e todos os IPs são conferidos).
 */
async function validateTargetUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) {
    throw new HttpError(400, 'Informe uma URL válida (até 2048 caracteres).');
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HttpError(400, 'URL inválida. Exemplo: https://exemplo.com/pagina');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'Apenas endereços http:// e https:// são aceitos.');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'URLs com usuário/senha não são aceitas: o WebMirror só captura páginas públicas.');
  }
  if (!CONFIG.allowPrivateNetworks) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = (await dns.lookup(host, { all: true })).map((entry) => entry.address);
      } catch {
        throw new HttpError(400, `Não foi possível encontrar o domínio "${host}".`);
      }
    }
    if (addresses.some(isPrivateAddress)) {
      throw new HttpError(403, 'Endereços de rede local/privada estão bloqueados (ALLOW_PRIVATE_NETWORKS=false).');
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// Navegador (uma instância compartilhada; um contexto limpo por captura)
// ---------------------------------------------------------------------------

let browserPromise = null;

/** Abre o Chromium na primeira captura e reaproveita nas seguintes; reabre se ele cair. */
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: true, args: ['--disable-dev-shm-usage'] })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }
  return browserPromise;
}

/** Fecha o navegador, se estiver aberto (usado no desligamento do servidor). */
async function closeBrowser() {
  const browser = await browserPromise?.catch(() => null);
  await browser?.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Captura: interceptação de rede e coleta de arquivos estáticos
// ---------------------------------------------------------------------------

/** Diz se o domínio é de embed público (YouTube, Vimeo ou EMBED_HOSTS). */
function isEmbedHost(hostname) {
  const host = hostname.toLowerCase();
  return EMBED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Adiciona um aviso à captura, uma vez só por chave (evita repetir o mesmo aviso 300 vezes). */
function warnOnce(capture, key, message) {
  if (capture.warningKeys.has(key)) return;
  capture.warningKeys.add(key);
  capture.warnings.push(message);
}

/**
 * Decide o que fazer com cada pedido da página (page.route):
 * - localhost/IP privado → bloqueia (proteção da rede interna);
 * - vídeo/áudio (tipo "media" ou extensão de vídeo) → responde vazio, sem baixar o binário;
 * - o resto segue normalmente.
 */
async function handleRoute(route, capture) {
  const request = route.request();
  const url = request.url();
  try {
    const { hostname, pathname } = new URL(url);
    if (!CONFIG.allowPrivateNetworks && isPrivateHostLiteral(hostname)) {
      capture.blockedRequests.push(url);
      return await route.abort('blockedbyclient');
    }
    if (request.resourceType() === 'media' || VIDEO_EXTENSION_RE.test(pathname)) {
      capture.skippedMedia.add(url);
      return await route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    }
    return await route.continue();
  } catch {
    // Pedido de página já fechada ou URL estranha (data:, blob:): seguir em frente sem derrubar a captura.
    await route.continue().catch(() => {});
  }
}

/** Monta o caminho local de um arquivo: assets/<pasta>/<hash>-<nome><extensão>. */
function buildLocalPath(url, folder, contentType) {
  const { pathname } = new URL(url);
  let baseName;
  try {
    baseName = decodeURIComponent(path.posix.basename(pathname));
  } catch {
    baseName = path.posix.basename(pathname);
  }
  const urlExtension = path.posix.extname(baseName).toLowerCase();
  const stem = baseName.slice(0, baseName.length - urlExtension.length);
  const mimeExtension = EXTENSION_BY_MIME[contentType.split(';')[0].trim().toLowerCase()];

  // CSS e JS sempre com a extensão certa: aberto via file://, o navegador decide o tipo por ela.
  let extension;
  if (folder === 'css') extension = '.css';
  else if (folder === 'js') extension = '.js';
  else extension = mimeExtension || (/^\.[a-z0-9]{1,5}$/.test(urlExtension) ? urlExtension : '');

  const safeStem =
    stem
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || 'arquivo';
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
  return `assets/${folder}/${hash}-${safeStem}${extension}`;
}

/** Liga as URLs anteriores de um redirecionamento ao mesmo arquivo local (o HTML usa a URL original). */
function registerRedirectAliases(request, entry, capture) {
  for (let previous = request.redirectedFrom(); previous; previous = previous.redirectedFrom()) {
    capture.aliases.set(previous.url(), entry);
  }
}

/**
 * Guarda em disco um CSS, JS, imagem ou fonte que a página carregou (page.on('response')).
 * Arquivos acima de MAX_ASSET_SIZE_MB ficam de fora e continuam apontando para o site original.
 */
async function collectAsset(response, capture) {
  const request = response.request();
  const folder = ASSET_FOLDERS[request.resourceType()];
  const url = response.url();
  if (!folder || !/^https?:/i.test(url)) return;

  // 3xx não tem corpo: o destino do redirecionamento chega como outra resposta.
  const status = response.status();
  if (status < 200 || status >= 300) return;

  const existing = capture.assets.get(url);
  if (existing) {
    registerRedirectAliases(request, existing, capture);
    return;
  }
  if (capture.assets.size >= CONFIG.maxAssets) {
    warnOnce(capture, 'max-assets', `Limite de ${CONFIG.maxAssets} arquivos atingido; o restante continua apontando para o site original.`);
    return;
  }

  const headers = response.headers();
  const declaredBytes = Number(headers['content-length'] || 0);
  if (declaredBytes > CONFIG.maxAssetBytes) {
    capture.skippedLarge.push({ url, bytes: declaredBytes });
    return;
  }

  const contentType = headers['content-type'] || '';
  const entry = { url, folder, contentType, path: buildLocalPath(url, folder, contentType), bytes: 0 };
  // Reserva a URL antes do await para a mesma resposta não ser gravada duas vezes.
  capture.assets.set(url, entry);
  try {
    const body = await response.body();
    if (body.length > CONFIG.maxAssetBytes) {
      capture.assets.delete(url);
      capture.skippedLarge.push({ url, bytes: body.length });
      return;
    }
    const target = path.join(capture.siteDir, entry.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, body);
    entry.bytes = body.length;
    registerRedirectAliases(request, entry, capture);
  } catch {
    // Corpo indisponível (página fechou, resposta abortada): o HTML mantém a URL original.
    capture.assets.delete(url);
  }
}

/** Mapa final URL → caminho local, só com os arquivos gravados com sucesso (inclui redirecionamentos). */
function buildAssetMap(capture) {
  const map = new Map();
  for (const entry of capture.assets.values()) {
    if (entry.bytes > 0) map.set(entry.url, entry.path);
  }
  for (const [alias, entry] of capture.aliases) {
    if (entry.bytes > 0 && capture.assets.get(entry.url) === entry) map.set(alias, entry.path);
  }
  return map;
}

/**
 * Acompanha os pedidos em andamento para esperar a rede "assentar" depois da rolagem
 * (o 'networkidle' do Playwright só vale para o carregamento inicial).
 */
function createNetworkTracker(page) {
  let inflight = 0;
  let lastChange = Date.now();
  const started = () => {
    inflight += 1;
    lastChange = Date.now();
  };
  const finished = () => {
    inflight = Math.max(0, inflight - 1);
    lastChange = Date.now();
  };
  page.on('request', started);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);

  return {
    /** Espera `idleMs` sem pedidos em andamento; devolve false se estourar o tempo. */
    async waitForIdle(idleMs, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (inflight === 0 && Date.now() - lastChange >= idleMs) return true;
        await delay(100);
      }
      return false;
    },
  };
}

/**
 * Diz se a página aberta é uma tela de verificação anti-robô (Cloudflare "Just a moment...",
 * "Access denied" e parecidas). O WebMirror não contorna essas proteções: a captura falha
 * com uma mensagem clara em vez de empacotar a tela de bloqueio.
 */
async function isBotChallengePage(page) {
  return page
    .evaluate(() => {
      const title = document.title.toLowerCase();
      const titleMatch = /just a moment|attention required|checking your browser|access denied|um momento|verificando|verifique se você é humano/.test(title);
      const markers = document.querySelector(
        '#challenge-form, #cf-challenge-running, script[src*="challenges.cloudflare.com"], iframe[src*="challenges.cloudflare.com"]',
      );
      return titleMatch || Boolean(markers) || typeof window._cf_chl_opt !== 'undefined';
    })
    .catch(() => false);
}

/** Rola a página até o fim, aos poucos, para disparar imagens "lazy" e animações por rolagem. */
async function autoScroll(page) {
  await page.evaluate(
    async ({ maxSteps, stepDelayMs }) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      for (let i = 0; i < maxSteps; i += 1) {
        const before = window.scrollY;
        window.scrollBy(0, step);
        await sleep(stepDelayMs);
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
        if (atBottom || window.scrollY === before) break;
      }
      window.scrollTo(0, 0);
    },
    { maxSteps: 60, stepDelayMs: 150 },
  );
}

// ---------------------------------------------------------------------------
// Reescrita de caminhos
// ---------------------------------------------------------------------------

/**
 * Roda DENTRO do navegador (page.evaluate): copia a DOM renderizada e, na cópia, troca os
 * caminhos pelos arquivos locais (./assets/...) ou pela URL absoluta original, substitui
 * vídeos/áudios locais por placeholder e, se pedido, desativa os scripts.
 * Trabalha numa cópia para que os scripts da página não alterem nada no meio do caminho.
 * Precisa ser autocontida: o Playwright envia só o texto da função para o navegador.
 */
function snapshotInBrowser({ assetMap, embedHosts, disableScripts, placeholderPath, exampleVideoPath, mediaVerdicts, cssUrlPattern, cssImportPattern }) {
  const base = document.baseURI;
  const SKIP_RE = /^\s*(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;
  const JS_TYPES = ['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript'];
  const stats = { mediaReplaced: 0, mediaKeptOnline: 0, scriptsDisabled: 0, stylesRecovered: 0 };

  const toAbsolute = (value) => {
    try {
      return new URL(value.trim(), base).href;
    } catch {
      return null;
    }
  };
  const isLocal = (value) => typeof value === 'string' && value.startsWith('./assets/');
  // Arquivo baixado → "./assets/..."; não baixado → URL absoluta (funciona com internet).
  // Valor já local (ex.: o placeholder posto acima) fica como está.
  const resolve = (value) => {
    if (!value || SKIP_RE.test(value) || isLocal(value)) return value;
    const absolute = toAbsolute(value);
    if (!absolute) return value;
    const hashAt = absolute.indexOf('#');
    const clean = hashAt >= 0 ? absolute.slice(0, hashAt) : absolute;
    const hash = hashAt >= 0 ? absolute.slice(hashAt) : '';
    return assetMap[clean] ? `./${assetMap[clean]}${hash}` : absolute;
  };
  const isEmbed = (absolute) => {
    try {
      const host = new URL(absolute).hostname.toLowerCase();
      return embedHosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  };
  const rewriteCss = (text) =>
    text
      .replace(new RegExp(cssUrlPattern, 'gi'), (match, _quote, value) => (SKIP_RE.test(value) ? match : `url("${resolve(value)}")`))
      .replace(new RegExp(cssImportPattern, 'gi'), (_match, _quote, value) => `@import "${resolve(value)}"`);
  const rewriteSrcset = (value) => {
    if (/data:/i.test(value)) return value;
    return value
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        if (!parts[0]) return '';
        parts[0] = resolve(parts[0]);
        return parts.join(' ');
      })
      .filter(Boolean)
      .join(', ');
  };
  const moveAttribute = (el, from, to) => {
    if (!el.hasAttribute(from)) return;
    el.setAttribute(to, el.getAttribute(from));
    el.removeAttribute(from);
  };

  // CSS-in-JS (styled-components, emotion) grava regras pelo CSSOM e deixa o <style> vazio no HTML.
  // Guardar a lista viva antes de copiar: a cópia sai na mesma ordem.
  const liveStyles = Array.from(document.querySelectorAll('style'));
  const root = document.documentElement.cloneNode(true);
  const head = root.querySelector('head') || root.insertBefore(document.createElement('head'), root.firstChild);

  Array.from(root.querySelectorAll('style')).forEach((target, index) => {
    const sheet = liveStyles[index]?.sheet;
    if (!sheet) return;
    try {
      const parsed = new CSSStyleSheet();
      parsed.replaceSync(target.textContent || '');
      if (sheet.cssRules.length > parsed.cssRules.length) {
        target.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
        stats.stylesRecovered += 1;
      }
    } catch {
      // Folha inacessível: fica o texto original.
    }
  });
  (document.adoptedStyleSheets || []).forEach((sheet) => {
    try {
      const style = document.createElement('style');
      style.setAttribute('data-webmirror', 'adopted-stylesheet');
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
      head.appendChild(style);
      stats.stylesRecovered += 1;
    } catch {
      // Folha inacessível: segue sem ela.
    }
  });

  // O arquivo é gravado em UTF-8: trocar o charset original. <base> e CSP quebrariam os caminhos locais.
  root
    .querySelectorAll('base, meta[charset], meta[http-equiv="content-type" i], meta[http-equiv="content-security-policy" i]')
    .forEach((el) => el.remove());
  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.insertBefore(charset, head.firstChild);

  // Vídeo/áudio: embed/público (abre de qualquer lugar) → fica online; restrito → vídeo de exemplo.
  const verdicts = mediaVerdicts || {};
  root.querySelectorAll('video, audio').forEach((media) => {
    const sources = [media.getAttribute('src'), ...Array.from(media.querySelectorAll('source'), (s) => s.getAttribute('src'))]
      .filter(Boolean)
      .map(toAbsolute)
      .filter(Boolean);
    if (sources.length === 0) return;
    const keepOnline = sources.some((u) => isEmbed(u) || verdicts[u.split('#')[0]] === 'public');
    if (keepOnline) {
      stats.mediaKeptOnline += 1; // o resolve geral deixa src/source como URL absoluta (toca online)
      return;
    }
    // Restrito: guarda a URL original em data-webmirror-src e aponta para o vídeo de exemplo.
    moveAttribute(media, 'src', 'data-webmirror-src');
    media.querySelectorAll('source').forEach((source) => moveAttribute(source, 'src', 'data-webmirror-src'));
    media.removeAttribute('autoplay');
    if (media.tagName === 'VIDEO') {
      media.setAttribute('src', `./${exampleVideoPath}`);
      media.setAttribute('controls', '');
      media.setAttribute('preload', 'metadata');
      media.removeAttribute('poster');
    } else {
      media.setAttribute('preload', 'none'); // áudio restrito: sem fonte (não há áudio de exemplo)
    }
    media.parentNode?.insertBefore(
      document.createComment(' WebMirror: vídeo restrito trocado pelo vídeo de exemplo (URL original em data-webmirror-src) '),
      media,
    );
    stats.mediaReplaced += 1;
  });

  root.querySelectorAll('[src]').forEach((el) => el.setAttribute('src', resolve(el.getAttribute('src'))));
  root.querySelectorAll('[srcset]').forEach((el) => el.setAttribute('srcset', rewriteSrcset(el.getAttribute('srcset'))));
  root.querySelectorAll('[poster]').forEach((el) => el.setAttribute('poster', resolve(el.getAttribute('poster'))));
  root.querySelectorAll('object[data]').forEach((el) => el.setAttribute('data', resolve(el.getAttribute('data'))));
  root.querySelectorAll('form[action]').forEach((el) => el.setAttribute('action', resolve(el.getAttribute('action'))));
  // href cobre <a>, <link>, <area> e SVG (<use>, <image>), inclusive xlink:href.
  root.querySelectorAll('[*|href]').forEach((el) => {
    if (el.hasAttribute('href')) el.setAttribute('href', resolve(el.getAttribute('href')));
    const xlink = el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (xlink) el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', resolve(xlink));
  });
  root.querySelectorAll('[style]').forEach((el) => el.setAttribute('style', rewriteCss(el.getAttribute('style'))));
  root.querySelectorAll('style').forEach((el) => {
    el.textContent = rewriteCss(el.textContent || '');
  });

  // Arquivo local aberto via file:// não passa em integrity/crossorigin (o CSS ainda é reescrito).
  root.querySelectorAll('link[href], script[src]').forEach((el) => {
    if (isLocal(el.getAttribute('href') || el.getAttribute('src'))) {
      el.removeAttribute('integrity');
      el.removeAttribute('crossorigin');
    }
  });

  // Scripts desativados: o código continua no HTML e em assets/js para estudo, mas não roda
  // offline (re-renderização de SPA e módulos ES via file:// costumam deixar a página em branco).
  if (disableScripts) {
    root.querySelectorAll('script').forEach((script) => {
      const type = (script.getAttribute('type') || '').trim().toLowerCase();
      if (!JS_TYPES.includes(type)) return;
      script.setAttribute('data-webmirror-type', script.getAttribute('type') || '');
      script.setAttribute('type', 'text/plain');
      stats.scriptsDisabled += 1;
    });
  }

  const dt = document.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${!dt.publicId && dt.systemId ? ' SYSTEM' : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>`
    : '<!DOCTYPE html>';
  return { doctype, html: root.outerHTML, title: document.title, stats };
}

/** Descobre a codificação de um CSS: latin1 (byte a byte, sem perdas) se declarar charset que não é UTF-8. */
function detectCssEncoding(buffer) {
  const head = buffer.subarray(0, 120).toString('latin1');
  const declared = head.match(/^﻿?@charset\s+["']([^"']+)["']/i);
  return declared && !/^utf-?8$/i.test(declared[1]) ? 'latin1' : 'utf8';
}

/**
 * Reescreve url(...) e @import de um arquivo CSS: arquivo baixado → caminho relativo ao
 * próprio CSS (ex.: ../fonts/x.woff2); não baixado → URL absoluta original.
 */
function rewriteCssFile(cssText, cssEntry, assetMap) {
  const resolve = (raw) => {
    const value = raw.trim();
    if (!value || /^(data:|blob:|#|about:)/i.test(value)) return null;
    let absolute;
    try {
      absolute = new URL(value, cssEntry.url);
    } catch {
      return null;
    }
    const hash = absolute.hash;
    absolute.hash = '';
    const local = assetMap.get(absolute.href);
    if (!local) return absolute.href + hash;
    return path.posix.relative(path.posix.dirname(cssEntry.path), local) + hash;
  };
  return cssText
    .replace(new RegExp(CSS_URL_PATTERN, 'gi'), (match, _quote, value) => {
      const resolved = resolve(value);
      return resolved === null ? match : `url("${resolved}")`;
    })
    .replace(new RegExp(CSS_IMPORT_PATTERN, 'gi'), (match, _quote, value) => {
      const resolved = resolve(value);
      return resolved === null ? match : `@import "${resolved}"`;
    });
}

/** Aplica a reescrita de caminhos em todos os CSS baixados. */
async function rewriteStylesheets(capture, assetMap) {
  for (const entry of capture.assets.values()) {
    if (entry.folder !== 'css' || entry.bytes === 0) continue;
    const file = path.join(capture.siteDir, entry.path);
    const raw = await fsp.readFile(file);
    const encoding = detectCssEncoding(raw);
    await fsp.writeFile(file, Buffer.from(rewriteCssFile(raw.toString(encoding), entry, assetMap), encoding));
  }
}

// ---------------------------------------------------------------------------
// Captura completa de uma página
// ---------------------------------------------------------------------------

/** Deixa um texto seguro para ficar dentro de um comentário HTML. */
function safeForComment(text) {
  return String(text).replace(/--/g, '- -').replace(/>/g, '&gt;');
}

/** Texto de LEIA-ME que vai dentro do .zip (como abrir e o que cada pasta contém). */
function buildReadme({ sourceUrl, capturedAt, disableScripts }) {
  return [
    'WebMirror — snapshot de página pública para estudo offline',
    '',
    `Origem:        ${sourceUrl}`,
    `Capturado em:  ${capturedAt}`,
    '',
    'Como abrir: descompacte e dê dois cliques em index.html.',
    '',
    'Conteúdo:',
    '  index.html        DOM renderizada, com caminhos relativos para ./assets',
    '  assets/css        folhas de estilo (url() já apontando para os arquivos locais)',
    '  assets/js         scripts públicos carregados pela página',
    '  assets/img        imagens',
    '  assets/fonts      fontes',
    '  screenshot.jpg    a página inteira como o navegador viu (se pedido)',
    '  webmirror.json    manifesto: arquivos, mídias substituídas e avisos',
    '',
    'Observações:',
    '  - Os <script> do index.html estão desativados (type="text/plain"; tipo original em data-webmirror-type).',
    '  - Vídeos públicos (abrem de qualquer lugar) continuam como embed do original (precisam de internet).',
    '  - Vídeos restritos (link assinado/que expira, streaming ou que exige login) viraram o vídeo de exemplo',
    '    assets/webmirror/exemplo-webmirror.mp4 — a URL original fica em data-webmirror-src.',
    '  - Embeds do YouTube/Vimeo e arquivos não baixados continuam apontando para o site original (precisam de internet).',
    '  - Material de terceiros: use só para estudo; respeite os direitos autorais do site original.',
    '',
  ].join('\n');
}

/** Cria o estado de uma captura (os mapas de arquivos e as listas de avisos) e a pasta de saída. */
async function newCapture(siteDir) {
  await fsp.mkdir(siteDir, { recursive: true });
  return {
    siteDir,
    assets: new Map(),
    aliases: new Map(),
    pending: new Set(),
    skippedMedia: new Set(),
    skippedLarge: [],
    blockedRequests: [],
    warnings: [],
    warningKeys: new Set(),
  };
}

/**
 * Liga os coletores a uma aba: fecha pop-ups, intercepta a rede (filtro de mídia) e guarda
 * cada CSS/JS/imagem/fonte que a página carrega. Devolve o rastreador de rede ociosa.
 * Usado tanto na captura automática quanto na interativa — os dois coletam do mesmo jeito.
 */
async function wireCapture(page, context, capture) {
  // Pop-ups abertos pela página não interessam ao snapshot (registrado depois da aba principal).
  context.on('page', (popup) => {
    if (popup !== page) popup.close().catch(() => {});
  });
  page.setDefaultTimeout(CONFIG.navigationTimeoutMs);
  const network = createNetworkTracker(page);
  await page.route('**/*', (route) => handleRoute(route, capture));
  page.on('response', (response) => {
    const task = collectAsset(response, capture).finally(() => capture.pending.delete(task));
    capture.pending.add(task);
  });
  return network;
}

/**
 * Transforma a página já carregada em arquivos offline: rola para carregar as imagens
 * "lazy", tira a captura de tela, gera o index.html com caminhos relativos, reescreve os
 * CSS, e grava manifesto e LEIA-ME em `capture.siteDir`. Não navega nem checa barreiras:
 * recebe a aba no estado em que ela está (depois do goto automático ou da ação do usuário).
 * `onPhase` é opcional e só informa o andamento para a tela.
 */
async function renderAndPackage({ page, capture, network, options, sourceUrl, onPhase = () => {}, htmlFileName = 'index.html', writeMeta = true }) {
  onPhase('Rolando a página para carregar imagens');
  try {
    await autoScroll(page);
    await network.waitForIdle(800, CONFIG.networkIdleTimeoutMs);
  } catch {
    capture.warnings.push('Não foi possível rolar a página até o fim; imagens "lazy" podem ter ficado de fora.');
  }
  await Promise.allSettled([...capture.pending]);

  if (options.screenshot) {
    onPhase('Tirando a captura de tela');
    // Uma página → screenshot.jpg. Multipágina (interativo) → um .jpg por página, para não sobrescrever.
    const shotName = htmlFileName === 'index.html' ? 'screenshot.jpg' : `${htmlFileName.replace(/\.html$/, '')}-screenshot.jpg`;
    try {
      await page.screenshot({ path: path.join(capture.siteDir, shotName), fullPage: true, type: 'jpeg', quality: 80, timeout: 30_000 });
    } catch {
      capture.warnings.push('Não foi possível gerar a captura de tela da página inteira.');
    }
  }

  onPhase('Verificando vídeos (público × restrito)');
  const mediaVerdicts = await classifyPageMedia(page);

  onPhase('Reescrevendo caminhos para uso offline');
  const assetMap = buildAssetMap(capture);
  const snapshot = await page.evaluate(snapshotInBrowser, {
    assetMap: Object.fromEntries(assetMap),
    embedHosts: EMBED_HOSTS,
    disableScripts: options.disableScripts,
    placeholderPath: PLACEHOLDER_PATH,
    exampleVideoPath: EXAMPLE_VIDEO_PATH,
    mediaVerdicts,
    cssUrlPattern: CSS_URL_PATTERN,
    cssImportPattern: CSS_IMPORT_PATTERN,
  });
  await rewriteStylesheets(capture, assetMap);

  const capturedAt = new Date().toISOString();
  const finalUrl = page.url();
  const banner = `<!-- Capturado pelo WebMirror ${APP_VERSION} em ${capturedAt} | Origem: ${safeForComment(finalUrl)} | Uso: estudo offline -->`;
  await fsp.writeFile(path.join(capture.siteDir, htmlFileName), `${snapshot.doctype}\n${banner}\n${snapshot.html}\n`, 'utf8');

  await writeInternalAssets(capture.siteDir, snapshot.html);

  const saved = [...capture.assets.values()].filter((entry) => entry.bytes > 0);
  const countBy = (folder) => saved.filter((entry) => entry.folder === folder).length;
  const stats = {
    title: snapshot.title,
    finalUrl,
    assets: { css: countBy('css'), js: countBy('js'), img: countBy('img'), fonts: countBy('fonts') },
    assetBytes: saved.reduce((sum, entry) => sum + entry.bytes, 0),
    mediaRequestsBlocked: capture.skippedMedia.size,
    mediaElementsReplaced: snapshot.stats.mediaReplaced,
    mediaKeptOnline: snapshot.stats.mediaKeptOnline,
    scriptsDisabled: snapshot.stats.scriptsDisabled,
    stylesRecovered: snapshot.stats.stylesRecovered,
    largeFilesSkipped: capture.skippedLarge.length,
    privateRequestsBlocked: capture.blockedRequests.length,
  };

  // Meta (manifesto + LEIA-ME): na captura de uma página só, escreve aqui. No modo interativo
  // multipágina, quem escreve o manifesto combinado é o finishSession, depois de religar os links.
  if (writeMeta) {
    const manifest = {
      tool: 'WebMirror',
      version: APP_VERSION,
      sourceUrl,
      finalUrl,
      title: snapshot.title,
      capturedAt,
      mode: options.interactive ? 'interativo' : 'automatico',
      options,
      viewport: CONFIG.viewport,
      stats,
      warnings: capture.warnings,
      skippedMedia: [...capture.skippedMedia],
      skippedLargeFiles: capture.skippedLarge,
      blockedPrivateRequests: capture.blockedRequests,
      assets: saved.map(({ url, path: localPath, bytes, contentType }) => ({ url, path: localPath, bytes, contentType })),
    };
    await fsp.writeFile(path.join(capture.siteDir, 'webmirror.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await fsp.writeFile(
      path.join(capture.siteDir, 'LEIA-ME.txt'),
      buildReadme({ sourceUrl: finalUrl, capturedAt, disableScripts: options.disableScripts }),
      'utf8',
    );
  }

  return { stats, warnings: capture.warnings, title: snapshot.title, finalUrl, htmlFile: htmlFileName };
}

/**
 * Captura automática (sem intervenção): abre a página num contexto limpo, espera a rede,
 * recusa telas anti-robô e empacota. Devolve as estatísticas.
 */
async function capturePage(job, siteDir) {
  const capture = await newCapture(siteDir);
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: CONFIG.viewport,
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  let timedOut = false;
  // Tempo máximo da captura inteira: fechar o contexto faz qualquer passo em andamento falhar.
  const jobTimer = setTimeout(() => {
    timedOut = true;
    context.close().catch(() => {});
  }, CONFIG.jobTimeoutMs);

  try {
    const page = await context.newPage();
    const network = await wireCapture(page, context, capture);

    job.phase = 'Abrindo a página';
    const response = await page.goto(job.url, { waitUntil: 'load', timeout: CONFIG.navigationTimeoutMs });
    if (response && response.status() >= 400) {
      capture.warnings.push(`A página respondeu HTTP ${response.status()}; o conteúdo capturado pode ser uma página de erro.`);
    }

    job.phase = 'Aguardando a rede ficar ociosa';
    try {
      await page.waitForLoadState('networkidle', { timeout: CONFIG.networkIdleTimeoutMs });
    } catch {
      capture.warnings.push('A rede não ficou ociosa no tempo limite (página com conexões contínuas); captura feita assim mesmo.');
    }

    if (await isBotChallengePage(page)) {
      throw new Error(
        'O site exige verificação anti-robô (ex.: Cloudflare "Just a moment..."). A captura automática não contorna essa proteção; use o Modo interativo (você mesmo passa pela verificação na janela do navegador) ou abra a página no seu navegador e use "Salvar como".',
      );
    }

    return await renderAndPackage({
      page,
      capture,
      network,
      options: job.options,
      sourceUrl: job.url,
      onPhase: (phase) => {
        job.phase = phase;
      },
    });
  } catch (error) {
    if (timedOut) throw new Error(`Tempo máximo de captura excedido (${Math.round(CONFIG.jobTimeoutMs / 1000)} s).`);
    throw error;
  } finally {
    clearTimeout(jobTimer);
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Empacotamento
// ---------------------------------------------------------------------------

/**
 * Compacta a pasta inteira num .zip (zlib nível 9). Grava primeiro num ".part" e renomeia
 * no fim, para nunca existir um .zip pela metade na pasta de downloads.
 * Devolve o tamanho final em bytes.
 */
async function zipDirectory(sourceDir, zipPath) {
  const partialPath = `${zipPath}.part`;
  try {
    const bytes = await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(partialPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on('close', () => resolve(archive.pointer()));
      output.on('error', reject);
      archive.on('warning', (error) => {
        if (error.code !== 'ENOENT') reject(error);
      });
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize();
    });
    await fsp.rename(partialPath, zipPath);
    return bytes;
  } catch (error) {
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Fila de capturas (em memória)
// ---------------------------------------------------------------------------

const jobs = new Map();
const queue = [];
let runningJobs = 0;

/** Nome do .zip: <domínio>_<data-hora>_<id curto>.zip, fácil de achar na pasta de downloads. */
function buildZipName(url, id) {
  const host = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${host}_${stamp}_${id.slice(0, 8)}.zip`;
}

/** Converte a mensagem técnica do Playwright numa frase curta para a tela. */
function friendlyError(error) {
  const message = String(error?.message || error);
  const known = [
    [/ERR_NAME_NOT_RESOLVED/, 'Domínio não encontrado.'],
    [/ERR_CONNECTION_REFUSED/, 'O servidor recusou a conexão.'],
    [/ERR_CONNECTION_TIMED_OUT|Timeout .*exceeded/i, 'O site demorou demais para responder.'],
    [/ERR_CERT|SSL/i, 'Certificado HTTPS inválido no site de destino.'],
    [/ERR_TOO_MANY_REDIRECTS/, 'O site entrou em ciclo de redirecionamentos.'],
    [/Executable doesn't exist/, 'Navegador do Playwright não instalado (rode "npm run browsers").'],
  ];
  const match = known.find(([pattern]) => pattern.test(message));
  return match ? match[1] : message.split('\n')[0].slice(0, 300);
}

/** Cria uma captura, coloca na fila e já tenta iniciar. */
function enqueueJob(url, options) {
  const id = crypto.randomUUID();
  const job = {
    id,
    url,
    options,
    status: 'queued',
    phase: 'Na fila',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    stats: null,
    warnings: [],
    error: null,
    fileName: buildZipName(url, id),
    zipPath: null,
    zipBytes: 0,
  };
  jobs.set(id, job);
  queue.push(job);
  pumpQueue();
  return job;
}

/** Inicia capturas da fila até o limite de MAX_CONCURRENT_JOBS simultâneas. */
function pumpQueue() {
  while (runningJobs < CONFIG.maxConcurrentJobs && queue.length > 0) {
    const job = queue.shift();
    runningJobs += 1;
    runJob(job).finally(() => {
      runningJobs -= 1;
      pumpQueue();
    });
  }
}

/** Executa uma captura do começo ao fim; a pasta temporária é apagada sempre ao final. */
async function runJob(job) {
  const siteDir = path.join(CONFIG.workDir, job.id);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  try {
    const { stats, warnings } = await capturePage(job, siteDir);
    job.stats = stats;
    job.warnings = warnings;

    job.status = 'packaging';
    job.phase = 'Compactando o .zip';
    const zipPath = path.join(CONFIG.downloadDir, job.fileName);
    job.zipBytes = await zipDirectory(siteDir, zipPath);
    job.zipPath = zipPath;
    if (CONFIG.maxZipBytes > 0 && job.zipBytes > CONFIG.maxZipBytes) {
      job.warnings.push(
        `O .zip tem ${(job.zipBytes / MB).toFixed(1)} MB, acima do limite de alerta (${CONFIG.maxZipBytes / MB} MB).`,
      );
    }
    job.status = 'done';
    job.phase = 'Pronto';
    console.log(`[webmirror] captura ${job.id} pronta: ${job.url} → ${job.fileName} (${(job.zipBytes / MB).toFixed(2)} MB)`);
  } catch (error) {
    job.status = 'error';
    job.phase = 'Falhou';
    job.error = friendlyError(error);
    console.error(`[webmirror] captura ${job.id} falhou (${job.url}):`, error?.message || error);
  } finally {
    job.finishedAt = new Date().toISOString();
    await fsp.rm(siteDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Visão pública de uma captura (o que a API devolve; sem caminhos internos do servidor). */
function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    phase: job.phase,
    queuePosition: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    options: job.options,
    stats: job.stats,
    warnings: job.warnings,
    error: job.error,
    fileName: job.status === 'done' ? job.fileName : null,
    zipBytes: job.zipBytes,
    downloadUrl: job.status === 'done' ? `/download/${job.id}` : null,
  };
}

/**
 * Limpeza periódica: apaga .zip mais velhos que ZIP_RETENTION_HOURS (0 = guarda para sempre)
 * e esquece capturas antigas da memória.
 */
async function purgeExpired() {
  const now = Date.now();
  if (CONFIG.zipRetentionMs > 0) {
    const names = await fsp.readdir(CONFIG.downloadDir).catch(() => []);
    for (const name of names) {
      if (!/\.zip(\.part)?$/.test(name)) continue;
      const file = path.join(CONFIG.downloadDir, name);
      const info = await fsp.stat(file).catch(() => null);
      if (info && now - info.mtimeMs > CONFIG.zipRetentionMs) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
  const memoryRetentionMs = Math.max(CONFIG.zipRetentionMs, 24 * 3_600_000);
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - Date.parse(job.finishedAt) > memoryRetentionMs) jobs.delete(id);
  }
}

/** Apaga sobras de capturas interrompidas (só subpastas com nome de UUID, criadas por nós). */
async function cleanWorkDir() {
  await fsp.mkdir(CONFIG.workDir, { recursive: true });
  for (const name of await fsp.readdir(CONFIG.workDir)) {
    if (UUID_RE.test(name)) await fsp.rm(path.join(CONFIG.workDir, name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Sessões interativas (página com verificação anti-robô)
// ---------------------------------------------------------------------------
//
// Fluxo em dois passos, para sites que exigem uma verificação feita por uma pessoa
// (ex.: Cloudflare "Just a moment..."). O WebMirror NÃO contorna a proteção: quem passa
// pela verificação é o próprio usuário, na janela visível do navegador.
//   Passo 1 (POST /api/session): abre uma janela visível do Chromium na URL. O usuário
//            resolve a verificação com as próprias mãos.
//   Passo 2 (POST /api/session/:id/capture): com a página já liberada, faz o snapshot,
//            aplica o filtro de mídias e gera o .zip — a mesma lógica da captura automática.
//
// Uma sessão de cada vez: a janela é única e o perfil do navegador (cookies, para não
// refazer a verificação depois) fica numa pasta só, que o launchPersistentContext tranca
// enquanto está aberta. Precisa de uma tela: use rodando a app direto na máquina
// (npm start); dentro do container não há display por padrão.

const sessions = new Map();
let activeSession = null;

/** Visão pública de uma sessão interativa (sem o contexto do navegador nem caminhos internos). */
function publicSession(session) {
  return {
    id: session.id,
    url: session.url,
    kind: 'session',
    status: session.status,
    phase: session.phase,
    stillChallenged: session.stillChallenged,
    options: session.options,
    createdAt: session.createdAt,
    pages: session.pages.map((p) => ({ title: p.title, url: p.finalUrl, file: p.file })),
    capturedCount: session.pages.length,
    stats: session.stats,
    warnings: session.warnings,
    error: session.error,
    fileName: session.status === 'done' ? session.fileName : null,
    zipBytes: session.zipBytes,
    downloadUrl: session.status === 'done' ? `/download/${session.id}` : null,
  };
}

/** Fecha a janela do navegador de uma sessão, se ainda estiver aberta. */
async function closeSessionBrowser(session) {
  clearTimeout(session.idleTimer);
  const context = session.context;
  session.context = null;
  session.page = null;
  await context?.close().catch(() => {});
}

/** Encerra a sessão interativa ativa (tempo esgotado, cancelamento ou troca por outra). */
async function cancelSession(session, reason) {
  if (!session || ['done', 'error', 'cancelled'].includes(session.status)) return;
  session.status = 'cancelled';
  session.phase = 'Encerrada';
  session.error = reason;
  await closeSessionBrowser(session);
  await fsp.rm(path.join(CONFIG.workDir, session.id), { recursive: true, force: true }).catch(() => {});
  if (activeSession === session) activeSession = null;
}

/**
 * Passo 1: abre uma janela visível do navegador na URL, com um perfil persistente, e liga
 * os coletores. A sessão fica em "waiting" até o usuário mandar capturar ou o tempo esgotar.
 */
async function openSession(url, options) {
  if (!CONFIG.interactiveEnabled) {
    throw new HttpError(403, 'Modo interativo desligado (INTERACTIVE_ENABLED=false).');
  }
  if (activeSession && ['waiting', 'capturing'].includes(activeSession.status)) {
    throw new HttpError(409, 'Já existe uma sessão interativa aberta. Finalize ou cancele antes de abrir outra.');
  }

  const id = crypto.randomUUID();
  const siteDir = path.join(CONFIG.workDir, id);
  const capture = await newCapture(siteDir);
  const session = {
    id,
    url,
    options: { ...options, interactive: true },
    status: 'starting',
    phase: 'Abrindo a janela do navegador',
    stillChallenged: false,
    createdAt: new Date().toISOString(),
    context: null,
    page: null,
    network: null,
    capture,
    pages: [],
    usedFiles: new Set(),
    stats: null,
    warnings: [],
    error: null,
    fileName: buildZipName(url, id),
    zipPath: null,
    zipBytes: 0,
    idleTimer: null,
  };
  sessions.set(id, session);
  activeSession = session;

  let context;
  try {
    // Perfil persistente: guarda cookies/estado para não repetir a verificação na próxima vez.
    // headless:false → janela visível, onde o usuário passa pela verificação.
    context = await chromium.launchPersistentContext(CONFIG.profileDir, {
      headless: false,
      viewport: CONFIG.viewport,
      acceptDownloads: false,
    });
  } catch (error) {
    await cancelSession(session, friendlyInteractiveError(error));
    throw new HttpError(500, session.error);
  }

  session.context = context;
  const page = context.pages()[0] ?? (await context.newPage());
  session.page = page;
  session.network = await wireCapture(page, context, capture);

  session.phase = 'Carregando a página (passe pela verificação na janela)';
  session.status = 'waiting';
  // Navega sem travar a sessão: numa tela de verificação o "load" pode demorar; a janela
  // continua aberta para o usuário de qualquer forma.
  page
    .goto(url, { waitUntil: 'load', timeout: CONFIG.navigationTimeoutMs })
    .catch(() => capture.warnings.push('A página demorou a carregar; verifique a janela do navegador.'));

  // Desiste sozinha se o usuário não voltar dentro do tempo limite (não deixa janela aberta à toa).
  armIdleTimer(session);

  return session;
}

/**
 * Passo 2: com a página já liberada pelo usuário, faz o snapshot, empacota e fecha a janela.
 * Não resolve nem contorna verificação nenhuma: captura a página no estado em que o usuário
 * a deixou (avisa, mas não impede, se a tela de verificação ainda estiver no ar).
 */
/** Escapa um texto para uso literal dentro de um RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** (Re)arma o relógio que fecha a janela sozinha se o usuário sumir sem capturar/finalizar. */
function armIdleTimer(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    cancelSession(session, 'Tempo de espera esgotado: a janela ficou aberta sem captura.').catch(() => {});
  }, CONFIG.interactiveIdleTimeoutMs);
  session.idleTimer.unref?.();
}

/** Nome do arquivo .html de cada página capturada: a 1ª é index.html (a porta de entrada);
 *  as seguintes ganham um "slug" do caminho da URL (ou pagina-N), sempre único na sessão. */
function pageFileName(url, index, used) {
  if (index === 0) {
    used.add('index.html');
    return 'index.html';
  }
  let slug = '';
  try {
    const u = new URL(url);
    slug = (u.pathname + u.search).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  } catch {
    /* usa o fallback abaixo */
  }
  const base = slug ? `pagina-${slug}` : `pagina-${index + 1}`;
  let name = `${base}.html`;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}.html`;
  used.add(name);
  return name;
}

/**
 * Captura a página que está AGORA na janela e deixa a sessão aberta: o usuário pode navegar
 * para outra página e capturar de novo, ou finalizar. Cada página vira um arquivo .html na
 * mesma pasta (assets compartilhados e sem repetição). A religação dos links é feita só no fim.
 */
async function captureCurrentPage(session) {
  if (session.status !== 'waiting') {
    throw new HttpError(409, `A sessão não está aguardando captura (estado: ${session.status}).`);
  }
  clearTimeout(session.idleTimer);
  session.status = 'capturing';

  try {
    session.stillChallenged = await isBotChallengePage(session.page);
    if (session.stillChallenged) {
      session.capture.warnings.push('A página capturada parecia uma tela intermediária/de bloqueio; confira o conteúdo salvo.');
    }
    session.phase = 'Aguardando a rede ficar ociosa';
    await session.page.waitForLoadState('networkidle', { timeout: CONFIG.networkIdleTimeoutMs }).catch(() => {});

    const index = session.pages.length;
    const htmlFileName = pageFileName(session.page.url(), index, session.usedFiles);
    const { stats, warnings, title, finalUrl } = await renderAndPackage({
      page: session.page,
      capture: session.capture,
      network: session.network,
      options: session.options,
      sourceUrl: session.url,
      htmlFileName,
      writeMeta: false,
      onPhase: (phase) => {
        session.phase = phase;
      },
    });
    session.pages.push({ url: finalUrl, finalUrl, title, file: htmlFileName });
    session.stats = stats;
    session.warnings = warnings;

    // Volta a aguardar: capturar outra página ou finalizar. A janela continua aberta.
    session.status = 'waiting';
    session.phase = `Página salva (${session.pages.length} no total). Navegue para outra e capture, ou finalize.`;
    armIdleTimer(session);
    console.log(`[webmirror] sessão ${session.id}: página ${session.pages.length} salva (${htmlFileName}) ← ${finalUrl}`);
  } catch (error) {
    session.status = 'error';
    session.phase = 'Falhou';
    session.error = friendlyError(error);
    await closeSessionBrowser(session);
    await fsp.rm(session.capture.siteDir, { recursive: true, force: true }).catch(() => {});
    if (activeSession === session) activeSession = null;
    console.error(`[webmirror] sessão ${session.id} falhou ao capturar:`, error?.message || error);
  }
  return session;
}

/**
 * Religa os links internos: em cada página salva, um link que aponta para OUTRA página também
 * capturada passa a apontar para o arquivo local (./pagina.html). Links não capturados e de
 * outros domínios continuam apontando para a web. (O snapshot já deixou os href absolutos.)
 */
async function relinkCapturedPages(session) {
  if (session.pages.length < 2) return; // uma página só: não há o que religar
  const urlToFile = new Map();
  const addKey = (value, file) => {
    if (!value) return;
    const clean = value.split('#')[0];
    urlToFile.set(clean, file);
    urlToFile.set(clean.endsWith('/') ? clean.slice(0, -1) : `${clean}/`, file);
  };
  for (const p of session.pages) {
    addKey(p.finalUrl, p.file);
    addKey(p.url, p.file);
  }

  for (const p of session.pages) {
    const filePath = path.join(session.capture.siteDir, p.file);
    let html;
    try {
      html = await fsp.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    let changed = false;
    for (const [absUrl, file] of urlToFile) {
      for (const variant of new Set([absUrl, absUrl.replace(/&/g, '&amp;')])) {
        const re = new RegExp(`href=(["'])${escapeRegExp(variant)}(#[^"'\\s<>]*)?\\1`, 'g');
        html = html.replace(re, (_match, quote, frag) => {
          changed = true;
          return `href=${quote}./${file}${frag || ''}${quote}`;
        });
      }
    }
    if (changed) await fsp.writeFile(filePath, html, 'utf8');
  }
}

/** Escreve o manifesto combinado e o LEIA-ME de uma sessão (todas as páginas de uma vez). */
async function writeSessionMeta(session) {
  const capturedAt = new Date().toISOString();
  const saved = [...session.capture.assets.values()].filter((entry) => entry.bytes > 0);
  const manifest = {
    tool: 'WebMirror',
    version: APP_VERSION,
    mode: 'interativo',
    sourceUrl: session.url,
    capturedAt,
    viewport: CONFIG.viewport,
    pages: session.pages.map((p) => ({ title: p.title, url: p.finalUrl, file: p.file })),
    options: session.options,
    warnings: session.capture.warnings,
    skippedMedia: [...session.capture.skippedMedia],
    skippedLargeFiles: session.capture.skippedLarge,
    blockedPrivateRequests: session.capture.blockedRequests,
    assets: saved.map(({ url, path: localPath, bytes, contentType }) => ({ url, path: localPath, bytes, contentType })),
  };
  await fsp.writeFile(path.join(session.capture.siteDir, 'webmirror.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const list = session.pages.map((p, i) => `  ${i + 1}. ${p.file}  —  ${p.title || p.finalUrl}`).join('\n');
  const readme =
    `${buildReadme({ sourceUrl: session.url, capturedAt, disableScripts: session.options.disableScripts })}\n` +
    `Páginas capturadas (${session.pages.length}):\n${list}\n\n` +
    'Abra index.html. Os links entre as páginas capturadas apontam para os arquivos locais;\n' +
    'os demais links (páginas não capturadas e outros domínios) continuam apontando para a web.\n';
  await fsp.writeFile(path.join(session.capture.siteDir, 'LEIA-ME.txt'), readme, 'utf8');
}

/**
 * Finaliza a sessão: religa os links entre as páginas capturadas, escreve o manifesto combinado,
 * gera o .zip e fecha a janela. Exige ao menos uma página já capturada.
 */
async function finishSession(session) {
  if (session.status !== 'waiting') {
    throw new HttpError(409, `A sessão não está pronta para finalizar (estado: ${session.status}).`);
  }
  if (session.pages.length === 0) {
    throw new HttpError(409, 'Nenhuma página capturada ainda. Capture ao menos uma página antes de finalizar.');
  }
  clearTimeout(session.idleTimer);
  session.status = 'capturing';

  try {
    session.phase = 'Religando os links entre as páginas capturadas';
    await relinkCapturedPages(session);

    session.phase = 'Escrevendo o manifesto';
    await writeSessionMeta(session);

    session.phase = 'Compactando o .zip';
    const zipPath = path.join(CONFIG.downloadDir, session.fileName);
    session.zipBytes = await zipDirectory(session.capture.siteDir, zipPath);
    session.zipPath = zipPath;
    if (CONFIG.maxZipBytes > 0 && session.zipBytes > CONFIG.maxZipBytes) {
      session.warnings.push(`O .zip tem ${(session.zipBytes / MB).toFixed(1)} MB, acima do limite de alerta (${CONFIG.maxZipBytes / MB} MB).`);
    }

    // Registra como "captura pronta" para reaproveitar o download e a limpeza por retenção.
    jobs.set(session.id, {
      id: session.id,
      url: session.url,
      status: 'done',
      fileName: session.fileName,
      zipPath,
      zipBytes: session.zipBytes,
      finishedAt: new Date().toISOString(),
    });

    session.status = 'done';
    session.phase = 'Pronto';
    console.log(`[webmirror] sessão ${session.id} finalizada: ${session.pages.length} página(s) → ${session.fileName} (${(session.zipBytes / MB).toFixed(2)} MB)`);
  } catch (error) {
    session.status = 'error';
    session.phase = 'Falhou';
    session.error = friendlyError(error);
    console.error(`[webmirror] sessão ${session.id} falhou ao finalizar:`, error?.message || error);
  } finally {
    await closeSessionBrowser(session);
    await fsp.rm(session.capture.siteDir, { recursive: true, force: true }).catch(() => {});
    if (activeSession === session) activeSession = null;
  }
  return session;
}

/** Mensagem clara quando a janela visível não pode abrir (típico: rodando dentro do container). */
function friendlyInteractiveError(error) {
  const message = String(error?.message || error);
  if (/Missing X server|\$DISPLAY|Target page, context or browser has been closed|xvfb|libgtk|cannot open display/i.test(message)) {
    return 'Não foi possível abrir uma janela do navegador. O modo interativo precisa de uma tela: rode a aplicação direto na sua máquina (npm start), não dentro do container.';
  }
  if (/Executable doesn't exist/.test(message)) {
    return 'Navegador do Playwright não instalado (rode "npm run browsers").';
  }
  return `Falha ao abrir a janela do navegador: ${message.split('\n')[0].slice(0, 200)}`;
}


// ---------------------------------------------------------------------------
// Tela (formulário URL → Processar → link de download)
// ---------------------------------------------------------------------------

/** Página única da interface; o nonce libera só o script e o estilo desta resposta (CSP). */
function renderHomePage(nonce) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebMirror</title>
<style nonce="${nonce}">
  :root { --bg:#f6f7f9; --card:#fff; --text:#1f2937; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; --ok:#15803d; --err:#b91c1c; --warn:#a16207; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --card:#111827; --text:#e5e7eb; --muted:#9ca3af; --line:#1f2937; --accent:#60a5fa; --ok:#4ade80; --err:#f87171; --warn:#facc15; } }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:720px; margin:0 auto; padding:40px 16px; }
  h1 { margin:0 0 4px; font-size:28px; }
  p.lead { margin:0 0 24px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  label.url { display:block; font-weight:600; margin-bottom:8px; }
  .row { display:flex; gap:8px; }
  input[type=url] { flex:1; min-width:0; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--text); font-size:15px; }
  button { padding:10px 18px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; font-size:15px; }
  button:disabled { opacity:.6; cursor:progress; }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
  .switch { position:relative; display:inline-flex; align-items:center; gap:10px; cursor:pointer; color:var(--muted); font-size:14px; user-select:none; }
  .switch input { position:absolute; opacity:0; width:0; height:0; }
  .switch .track { width:40px; height:22px; border-radius:999px; background:var(--line); transition:background .15s; flex:0 0 auto; }
  .switch .track::after { content:''; display:block; width:18px; height:18px; margin:2px; border-radius:50%; background:#fff; transition:transform .15s; }
  .switch input:checked + .track { background:var(--accent); }
  .switch input:checked + .track::after { transform:translateX(18px); }
  .switch input:focus-visible + .track { outline:2px solid var(--accent); outline-offset:2px; }
  .pages { flex-basis:100%; margin:4px 0 0; padding-left:18px; font-size:13px; color:var(--text); }
  .pages li { margin:2px 0; }
  .options { display:flex; flex-wrap:wrap; gap:16px; margin-top:12px; color:var(--muted); font-size:14px; }
  .interactive-row { margin-top:16px; padding-top:16px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:8px; }
  .interactive-row small { font-size:13px; }
  .session-controls { margin:12px 0; padding:12px; border:1px dashed var(--accent); border-radius:8px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .session-controls p { flex-basis:100%; margin:0 0 4px; font-size:14px; }
  .status { font-weight:600; }
  .status.done { color:var(--ok); } .status.error { color:var(--err); }
  ul { margin:8px 0 0; padding-left:20px; } li { margin:2px 0; }
  .warnings li { color:var(--warn); }
  a.download { display:inline-block; margin-top:12px; padding:10px 18px; border-radius:8px; background:var(--ok); color:#fff; text-decoration:none; font-weight:600; }
  .hidden { display:none !important; }
  small { color:var(--muted); }
  @media (max-width:520px) { .row { flex-direction:column; } }
</style>
</head>
<body>
<main>
  <h1>WebMirror</h1>
  <p class="lead">Salva a DOM renderizada e os arquivos estáticos públicos de uma página num .zip para estudo offline de front-end.</p>

  <form class="card" id="form">
    <label class="url" for="url">URL pública</label>
    <div class="row">
      <input type="url" id="url" name="url" placeholder="https://exemplo.com" required autocomplete="off">
      <button type="submit" id="submit">Processar</button>
    </div>
    <div class="options">
      <label class="switch"><input type="checkbox" id="screenshot" checked><span class="track"></span> Incluir captura de tela</label>
    </div>
    <div class="interactive-row">
      <button type="button" id="interactive" class="secondary">Modo interativo</button>
      <small>Abre uma janela do navegador que você controla: navegue até a página que quer salvar e clique em capturar. Dá para capturar várias páginas em sequência — os links entre as páginas capturadas ficam locais. (Precisa rodar a app na sua máquina, não no container.)</small>
    </div>
  </form>

  <section class="card hidden" id="result" aria-live="polite">
    <div class="status" id="status"></div>
    <small id="phase"></small>
    <div class="session-controls hidden" id="sessionControls">
      <p id="sessionHint">Navegue na janela do navegador até a página que quer salvar e clique em “Capturar esta página”. Repita para quantas páginas quiser; no fim, clique em “Finalizar e baixar”.</p>
      <button type="button" id="captureNow">Capturar esta página</button>
      <button type="button" id="finishSession" class="secondary" disabled>Finalizar e baixar</button>
      <button type="button" id="cancelSession" class="ghost">Cancelar</button>
      <ul class="pages hidden" id="capturedPages"></ul>
    </div>
    <ul id="stats"></ul>
    <ul class="warnings" id="warnings"></ul>
    <a class="download hidden" id="download" href="#">Baixar .zip</a>
  </section>

  <small>Só páginas públicas, sem login. Respeite os direitos autorais e os termos de uso dos sites.</small>
</main>
<script nonce="${nonce}">
  var form = document.getElementById('form');
  var submit = document.getElementById('submit');
  var interactiveBtn = document.getElementById('interactive');
  var result = document.getElementById('result');
  var statusEl = document.getElementById('status');
  var phaseEl = document.getElementById('phase');
  var statsEl = document.getElementById('stats');
  var warningsEl = document.getElementById('warnings');
  var downloadEl = document.getElementById('download');
  var sessionControls = document.getElementById('sessionControls');
  var captureNowBtn = document.getElementById('captureNow');
  var finishBtn = document.getElementById('finishSession');
  var cancelSessionBtn = document.getElementById('cancelSession');
  var capturedPagesEl = document.getElementById('capturedPages');
  var LABELS = {
    queued: 'Na fila', running: 'Capturando…', packaging: 'Compactando…', done: 'Pronto', error: 'Falhou',
    starting: 'Abrindo a janela…', waiting: 'Aguardando você na janela do navegador', capturing: 'Capturando…', cancelled: 'Cancelada'
  };
  var DONE = { done: 1, error: 1, cancelled: 1 };

  function fillList(list, items) {
    list.textContent = '';
    items.forEach(function (text) { var li = document.createElement('li'); li.textContent = text; list.appendChild(li); });
  }
  function mb(bytes) { return (bytes / 1048576).toFixed(2) + ' MB'; }
  function setBusy(busy) { submit.disabled = busy; interactiveBtn.disabled = busy; }

  function render(job) {
    result.classList.remove('hidden');
    statusEl.className = 'status ' + job.status;
    statusEl.textContent = (LABELS[job.status] || job.status) + (job.error ? ': ' + job.error : '');
    phaseEl.textContent = job.status === 'queued' && job.queuePosition ? 'Posição na fila: ' + job.queuePosition : (DONE[job.status] ? '' : (job.phase || ''));
    var s = job.stats;
    fillList(statsEl, s ? [
      'Título: ' + (s.title || '(sem título)'),
      'Arquivos: ' + s.assets.css + ' CSS, ' + s.assets.js + ' JS, ' + s.assets.img + ' imagens, ' + s.assets.fonts + ' fontes (' + mb(s.assetBytes) + ')',
      'Mídias substituídas por placeholder: ' + s.mediaElementsReplaced + ' (pedidos de mídia bloqueados: ' + s.mediaRequestsBlocked + ')',
      'Scripts desativados: ' + s.scriptsDisabled,
      job.zipBytes ? 'Tamanho do .zip: ' + mb(job.zipBytes) : ''
    ].filter(Boolean) : []);
    fillList(warningsEl, job.warnings || []);
    if (job.downloadUrl) { downloadEl.href = job.downloadUrl; downloadEl.classList.remove('hidden'); }
    else { downloadEl.classList.add('hidden'); }
  }

  // Lista das páginas já capturadas na sessão e estado do botão "Finalizar".
  function renderCaptured(s) {
    var pages = s.pages || [];
    if (pages.length) {
      capturedPagesEl.classList.remove('hidden');
      capturedPagesEl.textContent = '';
      pages.forEach(function (p, i) {
        var li = document.createElement('li');
        li.textContent = (i + 1) + '. ' + (p.title || p.url) + '  (' + p.file + ')';
        capturedPagesEl.appendChild(li);
      });
    } else {
      capturedPagesEl.classList.add('hidden');
      capturedPagesEl.textContent = '';
    }
    finishBtn.disabled = !(s.status === 'waiting' && pages.length > 0);
  }

  // --- Captura automática ---
  function poll(id) {
    fetch('/api/jobs/' + id, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (job) {
        render(job);
        if (job.status === 'done' || job.status === 'error' || !job.id) { setBusy(false); return; }
        setTimeout(function () { poll(id); }, 1500);
      })
      .catch(function () { setTimeout(function () { poll(id); }, 3000); });
  }

  function body() {
    return {
      url: document.getElementById('url').value,
      screenshot: document.getElementById('screenshot').checked
    };
  }
  function post(url, payload) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    sessionControls.classList.add('hidden');
    setBusy(true);
    render({ status: 'queued', phase: 'Enviando…', warnings: [] });
    post('/api/capture', body())
      .then(function (res) {
        if (!res.ok) { render({ status: 'error', error: res.body.error || 'Erro ao iniciar a captura.', warnings: [] }); setBusy(false); return; }
        render(res.body);
        poll(res.body.id);
      })
      .catch(function () { render({ status: 'error', error: 'Servidor indisponível.', warnings: [] }); setBusy(false); });
  });

  // --- Modo interativo (duas etapas) ---
  var sessionId = null;

  function showControls(show) { sessionControls.classList.toggle('hidden', !show); }

  function pollSession(id) {
    if (id !== sessionId) return;
    fetch('/api/session/' + id, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (id !== sessionId) return;
        render(s);
        var active = s.status === 'waiting' || s.status === 'capturing';
        showControls(active);
        renderCaptured(s);
        captureNowBtn.disabled = s.status !== 'waiting';
        cancelSessionBtn.disabled = s.status !== 'waiting';
        if (DONE[s.status]) { setBusy(false); sessionId = null; return; }
        setTimeout(function () { pollSession(id); }, 1500);
      })
      .catch(function () { setTimeout(function () { pollSession(id); }, 3000); });
  }

  interactiveBtn.addEventListener('click', function () {
    if (!document.getElementById('url').value) { document.getElementById('url').reportValidity(); return; }
    setBusy(true);
    showControls(false);
    capturedPagesEl.classList.add('hidden');
    capturedPagesEl.textContent = '';
    finishBtn.disabled = true;
    render({ status: 'starting', phase: 'Abrindo a janela do navegador…', warnings: [] });
    post('/api/session', body())
      .then(function (res) {
        if (!res.ok) { render({ status: 'error', error: res.body.error || 'Não foi possível abrir a sessão.', warnings: [] }); setBusy(false); return; }
        sessionId = res.body.id;
        render(res.body);
        showControls(true);
        renderCaptured(res.body);
        pollSession(sessionId);
      })
      .catch(function () { render({ status: 'error', error: 'Servidor indisponível.', warnings: [] }); setBusy(false); });
  });

  captureNowBtn.addEventListener('click', function () {
    if (!sessionId) return;
    captureNowBtn.disabled = true;
    finishBtn.disabled = true;
    cancelSessionBtn.disabled = true;
    render({ status: 'capturing', phase: 'Capturando a página…', warnings: [] });
    post('/api/session/' + sessionId + '/capture')
      .then(function (res) {
        if (res.body && res.body.id === sessionId && res.body.pages) {
          render(res.body);
          var active = res.body.status === 'waiting' || res.body.status === 'capturing';
          showControls(active);
          renderCaptured(res.body);
          captureNowBtn.disabled = res.body.status !== 'waiting';
          cancelSessionBtn.disabled = res.body.status !== 'waiting';
        }
        if (!res.ok) { render({ status: 'error', error: res.body.error || 'Falha na captura.', warnings: [] }); showControls(false); setBusy(false); sessionId = null; }
        // Em caso de sucesso, o pollSession em andamento segue atualizando a lista.
      })
      .catch(function () { captureNowBtn.disabled = false; cancelSessionBtn.disabled = false; });
  });

  finishBtn.addEventListener('click', function () {
    if (!sessionId) return;
    captureNowBtn.disabled = true;
    finishBtn.disabled = true;
    cancelSessionBtn.disabled = true;
    render({ status: 'capturing', phase: 'Finalizando: religando links e compactando…', warnings: [] });
    post('/api/session/' + sessionId + '/finish')
      .then(function (res) {
        if (!res.ok) { render({ status: 'error', error: res.body.error || 'Falha ao finalizar.', warnings: [] }); showControls(false); setBusy(false); sessionId = null; return; }
        // Sucesso: o pollSession em andamento mostra o resultado final (download).
      })
      .catch(function () { finishBtn.disabled = false; });
  });

  cancelSessionBtn.addEventListener('click', function () {
    if (!sessionId) return;
    var id = sessionId;
    post('/api/session/' + id + '/cancel').then(function (res) {
      render(res.body || { status: 'cancelled', warnings: [] });
      showControls(false);
      capturedPagesEl.classList.add('hidden');
      setBusy(false);
      sessionId = null;
    });
  });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// API HTTP
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// JSON pequeno para as rotas da API (URL + opções).
app.use(express.json({ limit: '10kb' }));

/** Cabeçalhos de segurança em todas as respostas; API sem cache. */
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

app.get('/', (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  res.type('html').send(renderHomePage(nonce));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: APP_VERSION,
    running: runningJobs,
    queued: queue.length,
    interactiveEnabled: CONFIG.interactiveEnabled,
    interactiveBusy: Boolean(activeSession && ['waiting', 'capturing'].includes(activeSession.status)),
  });
});

app.post('/api/capture', async (req, res) => {
  const { url, screenshot = true } = req.body ?? {};
  const target = await validateTargetUrl(url);
  if (queue.length >= CONFIG.maxQueuedJobs) {
    throw new HttpError(429, 'Fila cheia. Aguarde as capturas em andamento terminarem.');
  }
  // Esta versão captura sempre a foto estática (scripts desativados no index.html).
  const job = enqueueJob(target.href, { disableScripts: true, screenshot: screenshot !== false });
  res.status(202).location(`/api/jobs/${job.id}`).json(publicJob(job));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = UUID_RE.test(req.params.id) ? jobs.get(req.params.id) : undefined;
  if (!job) throw new HttpError(404, 'Captura não encontrada.');
  res.json(publicJob(job));
});

// --- Modo interativo (abrir a janela → capturar quantas páginas quiser → finalizar) ---

app.post('/api/session', async (req, res) => {
  const { url, screenshot = true } = req.body ?? {};
  const target = await validateTargetUrl(url);
  const session = await openSession(target.href, { disableScripts: true, screenshot: screenshot !== false });
  res.status(202).location(`/api/session/${session.id}`).json(publicSession(session));
});

/** Procura uma sessão interativa por id. */
function findSession(id) {
  const session = UUID_RE.test(id) ? sessions.get(id) : undefined;
  if (!session) throw new HttpError(404, 'Sessão não encontrada ou já encerrada.');
  return session;
}

app.get('/api/session/:id', (req, res) => {
  res.json(publicSession(findSession(req.params.id)));
});

app.post('/api/session/:id/capture', async (req, res) => {
  const session = findSession(req.params.id);
  await captureCurrentPage(session);
  res.json(publicSession(session));
});

app.post('/api/session/:id/finish', async (req, res) => {
  const session = findSession(req.params.id);
  await finishSession(session);
  res.json(publicSession(session));
});

app.post('/api/session/:id/cancel', async (req, res) => {
  const session = findSession(req.params.id);
  await cancelSession(session, 'Cancelada pelo usuário.');
  res.json(publicSession(session));
});


app.get('/download/:id', (req, res, next) => {
  const job = UUID_RE.test(req.params.id) ? jobs.get(req.params.id) : undefined;
  if (!job || job.status !== 'done') throw new HttpError(404, 'Arquivo não encontrado ou ainda em processamento.');
  res.download(job.zipPath, job.fileName, (error) => {
    if (!error || res.headersSent) return;
    next(error.code === 'ENOENT' ? new HttpError(410, 'O .zip expirou e foi apagado. Faça a captura de novo.') : error);
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

/** Converte qualquer erro numa resposta JSON; detalhes técnicos só no log. */
app.use((error, req, res, _next) => {
  const status = error.status ?? error.statusCode ?? 500;
  if (status >= 500) console.error('[webmirror] erro interno:', error);
  const message =
    error.type === 'entity.parse.failed'
      ? 'JSON inválido no corpo da requisição.'
      : status >= 500
        ? 'Erro interno no servidor.'
        : error.message;
  res.status(status).json({ error: message });
});

// ---------------------------------------------------------------------------
// Inicialização e desligamento
// ---------------------------------------------------------------------------

let server;

/** Prepara as pastas, agenda a limpeza e sobe o servidor HTTP. */
async function start() {
  await fsp.mkdir(CONFIG.downloadDir, { recursive: true });
  try {
    await fsp.access(CONFIG.downloadDir, fs.constants.W_OK);
  } catch {
    throw new Error(`Sem permissão de escrita em ${CONFIG.downloadDir}. No Linux, ajuste o dono da pasta ./downloads do volume.`);
  }
  await cleanWorkDir();
  await purgeExpired();
  setInterval(() => purgeExpired().catch(() => {}), 15 * 60_000).unref();

  server = app.listen(CONFIG.port, () => {
    console.log(`[webmirror] ${APP_VERSION} ouvindo na porta ${CONFIG.port} | downloads em ${CONFIG.downloadDir}`);
  });
}

/** Desligamento limpo: para de aceitar conexões e fecha o navegador. */
async function shutdown(signal) {
  console.log(`[webmirror] ${signal} recebido, encerrando...`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server?.close();
  if (activeSession) await cancelSession(activeSession, 'Servidor encerrado.').catch(() => {});
  await closeBrowser();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((error) => {
  console.error('[webmirror] falha ao iniciar:', error.message);
  process.exit(1);
});
