FROM node:22-alpine

WORKDIR /usr/src/app

# Install ffmpeg for media processing
RUN apk update && apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 7071

CMD ["node", "src/start.js"]
