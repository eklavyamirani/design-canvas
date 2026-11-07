# canvas-web: the editor for the app platform (app-platform record 0050), with
# rooms on (VITE_COLLAB). Unprivileged nginx on port 8080 with temp files in
# /tmp, so it runs with a read-only root as any uid.
FROM --platform=$BUILDPLATFORM docker.io/library/node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The public build that may hand a drawing to this one (src/handoff.ts).
ARG VITE_PAGES_ORIGIN=https://github.ekkylab.uk
RUN VITE_COLLAB=on VITE_PAGES_ORIGIN=$VITE_PAGES_ORIGIN npm run build

FROM docker.io/nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
