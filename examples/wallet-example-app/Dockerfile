# The wallet example as one image for every role (ADR-0022): the roles differ by WALLET_ROLES, not by image. Build from the repository root:
#   docker build -f examples/wallet-example-app/Dockerfile -t crablet-wallet:lab .
# Dependencies are installed with Bun (the lockfile is Bun's) and the app runs on Node, which strips the TypeScript types itself (Node 24 or later).
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/examples/wallet-example-app
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.ts"]
