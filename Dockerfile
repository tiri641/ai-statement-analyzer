FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY migrations ./migrations
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY rds-ca-rsa2048-g1.pem ./rds-ca-rsa2048-g1.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca-rsa2048-g1.pem
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
