# WebMirror — imagem da aplicação.
# Base: imagem oficial do Playwright (Node.js + Chromium + bibliotecas do sistema já instaladas).
# A versão da tag TEM de ser a mesma do pacote "playwright" no package.json (hoje 1.65.0);
# senão o pacote procura um navegador que não existe na imagem.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

ENV NODE_ENV=production \
    PORT=3000 \
    DOWNLOAD_DIR=/app/downloads \
    WORK_DIR=/tmp/webmirror

WORKDIR /app

# Dependências primeiro: a camada só é refeita quando package*.json muda.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY server-assets ./server-assets

# Roda sem root (usuário pwuser já vem na imagem do Playwright).
RUN mkdir -p /app/downloads /tmp/webmirror \
    && chown -R pwuser:pwuser /app/downloads /tmp/webmirror
USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
