FROM node:22-alpine

WORKDIR /app

# Install production deps only, FROM THE LOCK.
#
# This was `npm install --omit=dev`, which resolves against the live registry
# every build. The lock had never listed vitest (a dev dependency; tests run
# from the workspace root, so nothing local ever noticed), and on 3 September
# 2026 resolving it hit a peer graph npm 10.9 cannot walk: "Cannot read
# properties of null (reading 'edgesOut')". The deploy failed and nothing in
# the commit had touched a dependency. `npm ci` installs exactly what the
# lock says and refuses a lock that is out of step with package.json, so a
# stale lock is caught here, loudly, rather than resolved differently each day.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q --spider http://localhost:3001/health || exit 1

EXPOSE 3001

CMD ["node", "src/index.js"]
