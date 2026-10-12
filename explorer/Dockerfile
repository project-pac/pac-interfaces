# PAC's public explorer (explorer.projectpac.net). Build from the repo root:
#   docker build -f explorer/Dockerfile .   (Railway: RAILWAY_DOCKERFILE_PATH=explorer/Dockerfile)
# It reads only what anyone can: the descriptor, the bulletin and the vault's
# public objects. It has no PAC home and serves nobody's sessions.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY pac ./pac
COPY explorer ./explorer
COPY bin ./bin
ENV PAC_EXPLORER_DATA=/data
CMD ["node", "bin/main.ts", "explorer", "--public"]
