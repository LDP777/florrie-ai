FROM node:20-alpine

WORKDIR /app

# Install production deps only
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY src/ ./src/

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q --spider http://localhost:3001/health || exit 1

EXPOSE 3001

CMD ["node", "src/index.js"]
