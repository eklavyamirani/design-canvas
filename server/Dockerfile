# canvas-collab: the room server for the app platform (app-platform record
# 0050). Node runs the TypeScript directly (type stripping). The platform's
# migrate Job runs this ENTRYPOINT with --migrate. Build context: the repo
# root, for shared/.
FROM docker.io/library/node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM docker.io/library/node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production
WORKDIR /app
COPY shared/ shared/
COPY server/package.json server/
COPY server/migrations/ server/migrations/
COPY server/src/ server/src/
COPY --from=deps /app/server/node_modules/ server/node_modules/
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "server/src/index.ts"]
