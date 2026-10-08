FROM node:24-alpine
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node server.mjs export.mjs ./
COPY --chown=node:node public ./public
USER node
ENV MICRO_HOST=0.0.0.0 MICRO_PORT=4319 MICRO_DATA_DIR=/data
EXPOSE 4319
CMD ["node", "server.mjs"]
