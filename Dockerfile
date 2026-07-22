FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

COPY --from=builder /app/.output ./.output

CMD ["node", ".output/server/index.mjs"]
