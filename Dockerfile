FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm test
EXPOSE 8080
CMD ["npm","start"]
