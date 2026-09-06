# One image, three entrypoints. The services are small and share a workspace;
# three near-identical Dockerfiles would be three things to keep in sync.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/ingester/package.json services/ingester/
COPY services/processor/package.json services/processor/
COPY services/api/package.json services/api/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build --workspaces --if-present

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app .
CMD ["node", "services/api/dist/main.js"]
