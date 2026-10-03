FROM node:22-slim
WORKDIR /app
# Dependências primeiro (melhor uso do cache). Em produção só o necessário: sem pacotes de desenvolvimento.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# O banco é um PostgreSQL EXTERNO (DATABASE_URL). O servidor não guarda dados em disco.
ENV NODE_ENV=production TRUST_PROXY_HOPS=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
