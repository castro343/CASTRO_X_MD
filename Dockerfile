FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# The current bot entry point and its runtime files live at the repository root.
COPY . .

EXPOSE 10000
ENV PORT=10000

CMD ["npm", "start"]
