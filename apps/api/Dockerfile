# =====================================================================
# API — Fastify روی Node 22، بدون مرحله Build
# =====================================================================
# TypeScript با `--experimental-strip-types` اجرا می‌شود (ADR-001)، پس
# اینجا `tsc` نداریم: همان فایل‌های src که در توسعه خوانده می‌شوند در
# تولید هم اجرا می‌شوند. یعنی Stack Trace تولید به خط واقعی اشاره
# می‌کند، بدون Source Map.
#
# ⚠️ نصب در مرحله جدا انجام می‌شود چون `argon2` ماژول بومی است و اگر
#    Prebuild موجود نباشد به کامپایلر نیاز دارد. ابزار کامپایل نباید
#    در ایمیج نهایی بماند.
# ---------------------------------------------------------------------
# رجیستری ایمیج پایه — پیش‌فرض همان Docker Hub رسمی است و تولید و Compose
# آن را عوض نمی‌کنند. فقط CI مقدار public.ecr.aws/docker/library را می‌دهد:
# همان Docker Official Images با همان digest، بی محدودیت نرخ ناشناس Hub.
ARG BASE_REGISTRY=docker.io/library
FROM ${BASE_REGISTRY}/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS deps

# python3/make/g++ فقط برای Fallback ساخت argon2 روی musl. اگر Prebuild
# پیدا شود، اصلاً استفاده نمی‌شوند.
RUN apk add --no-cache python3 make g++
RUN corepack enable
# بدون TTY، pnpm پیش از پاک‌کردن node_modules تأیید می‌خواهد و بیلد
# با پیامی نامربوط می‌ایستد. آزموده شد.
ENV CI=true

WORKDIR /app
# فقط مانیفست‌ها، تا لایه نصب با تغییر کد باطل نشود.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

# --frozen-lockfile الزام بند ۵ SECURITY.md است: نصب تولید هرگز نباید
# نسخه‌ای بیرون از Lockfile بیاورد.
RUN pnpm install --frozen-lockfile --prod --filter @labelmod/api

# ---------------------------------------------------------------------
FROM ${BASE_REGISTRY}/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime

# منطقه زمانی ظرف. «امروز» در منطق مالی از platform.timezone می‌آید نه
# از اینجا (README)، ولی لاگ و ساعت ظرف باید خوانا باشند.
RUN apk add --no-cache tzdata tini
ENV TZ=Asia/Tehran

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/src ./apps/api/src

# اجرا با کاربر غیر root — بند ۵ SECURITY.md.
RUN mkdir -p /var/lib/labelmod-woo /run/labelmod-panel-backup && chown node:node /var/lib/labelmod-woo /run/labelmod-panel-backup
USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# tini تا SIGTERM واقعاً به Node برسد و Shutdown تمیز اجرا شود.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]

# Keep the pg_dump client on exactly the same major version as the production database.
FROM ${BASE_REGISTRY}/postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d AS panel-backup
RUN apk add --no-cache libstdc++ "cmd:flock" tini age && mkdir -p /var/lib/labelmod-panel-backup /run/labelmod-panel-backup && chown 1000:1000 /var/lib/labelmod-panel-backup /run/labelmod-panel-backup
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /app /app
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["/sbin/tini", "--", "flock", "--no-fork", "--nonblock", "/var/lib/labelmod-panel-backup/manager.lock"]
CMD ["node", "--experimental-strip-types", "apps/api/src/cli/backup-manager.ts", "--panel-backup"]

FROM runtime AS api
