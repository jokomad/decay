# Dockerfile for Northflank deployment
FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source
COPY . .

# Expose Northflank standard port
ENV PORT=3000
EXPOSE 3000

# Start Bybit Decay Screener Server
CMD ["npm", "start"]
