FROM node:22-alpine

WORKDIR /app

# Install build deps for better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --production

COPY server/ ./server/
COPY client/ ./client/

# Data volume for SQLite persistence
VOLUME /app/data
ENV DB_PATH=/app/data/leaderboard.db

EXPOSE 9420

CMD ["node", "server/index.js"]
