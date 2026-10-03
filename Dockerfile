FROM node:22-slim
WORKDIR /app
COPY . .
# Banco SQLite em /data: monte um disco/volume persistente nesse caminho.
ENV NODE_ENV=production DB_FILE=/data/simulador.db TRUST_PROXY_HOPS=1
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
