FROM node:26-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
USER node
EXPOSE 7000
CMD ["node", "server.js"]
