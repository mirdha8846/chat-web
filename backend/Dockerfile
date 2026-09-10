FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npx tsc -p tsconfig.json
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
