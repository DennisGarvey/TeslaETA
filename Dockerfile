FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/eta.sqlite
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
