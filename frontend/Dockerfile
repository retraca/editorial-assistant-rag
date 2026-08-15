FROM node:20-alpine

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./

ENV BACKEND_URL=http://backend:8080
EXPOSE 5173

# Dev server rather than a static build + nginx: this is a local tool, and the
# Vite proxy keeps the frontend on a single origin with no CORS configuration.
CMD ["npx", "vite", "--host", "0.0.0.0"]
