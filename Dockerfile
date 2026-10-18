FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY public ./public
COPY src ./src
COPY server ./server
COPY scripts ./scripts
RUN pnpm build
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server/index.mjs"]
