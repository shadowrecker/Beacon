.PHONY: help install dev worker build worker-build test test-e2e lint type-check check migrate migrate-deploy drift seed services-up services-down docker-build clean

help:
	@echo "Beacon development commands"
	@echo "  make install        Install dependencies (generates the Prisma client)"
	@echo "  make services-up    Start local Postgres (5433) + Redis (6380) via Docker"
	@echo "  make migrate-deploy Apply migrations to DATABASE_URL"
	@echo "  make dev            Next.js dev server"
	@echo "  make worker         Background workers (tsx)"
	@echo "  make test           Unit + integration tests (needs Postgres + Redis)"
	@echo "  make test-e2e       Playwright end-to-end tests"
	@echo "  make check          Everything CI runs locally: types, lint, tests, completeness"
	@echo "  make build          Production build (web) ; make worker-build (worker bundle)"
	@echo "  make docker-build   Build web + worker images"

install:
	npm install

dev:
	npm run dev

worker:
	npm run worker

build:
	npm run build

worker-build:
	npm run worker:build

test:
	npm test

test-e2e:
	npm run test:e2e

lint:
	npm run lint

type-check:
	npm run type-check

check: type-check lint test
	npx tsx scripts/check-procedure-coverage.ts
	./scripts/check-no-mock-data.sh

migrate:
	npm run db:migrate

migrate-deploy:
	npm run db:migrate:deploy

drift:
	./scripts/check-migration-drift.sh

seed:
	npm run db:seed

services-up:
	docker compose -f docker-compose.dev.yml up -d

services-down:
	docker compose -f docker-compose.dev.yml down

docker-build:
	docker build -t beacon-web .
	docker build -f Dockerfile.worker -t beacon-worker .

clean:
	rm -rf .next dist coverage node_modules/.cache tsconfig.tsbuildinfo
