FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# The runtime image copies node_modules from here — keep only production deps.
RUN npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
RUN mkdir -p /app/data /app/plugins
# Express hides stack traces from 500 responses only in production.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/core/lifecycle.js"]
