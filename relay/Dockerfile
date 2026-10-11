# The shared PAC Slack app's relay. Build from the repo root:
#   docker build -f relay/Dockerfile .   (Railway: RAILWAY_DOCKERFILE_PATH=relay/Dockerfile)
# It holds the Slack tokens and who is linked (on the /data volume), never a PAC key.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY pac ./pac
COPY slack ./slack
COPY relay ./relay
COPY bin ./bin
ENV PAC_RELAY_DATA=/data
CMD ["node", "bin/main.ts", "relay"]
