FROM node:20-alpine

WORKDIR /app/backend

# Dependencies first so a source edit does not invalidate the install layer.
COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src

# The books ship with the image; the index is built at first run (or mounted).
COPY data/books /app/data/books

# The chapter and book notes are a COMMITTED artefact, not a build output — they
# cost ~$0.65 and 8 minutes to regenerate and only change when the corpus does.
# Leaving them out is what made every summary 404 inside the container while
# working perfectly outside it: the Library showed no notes and the assistant's
# about_the_book tool had nothing to read.
COPY data/summaries.json /app/data/summaries.json

ENV PROJECT_ROOT=/app
ENV PORT=8080
EXPOSE 8080

# `npm start` runs the compiled output; tsx is used here so the image stays a
# single stage and the source in the zip is what actually executes.
CMD ["npx", "tsx", "src/server.ts"]
