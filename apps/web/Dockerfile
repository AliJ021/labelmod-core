# =====================================================================
# رابط کاربری — بیلد Vite، سرو با Caddy
# =====================================================================
# خروجی Vite فایل ایستا است. به‌جای یک ظرف Node برای سرو کردنش، همان
# Caddy که TLS را می‌گیرد فایل‌ها را هم می‌دهد: یک سرویس کمتر، یک
# Hop کمتر، و هدرهای امنیتی در یک جا.
# ---------------------------------------------------------------------
# رجیستری ایمیج پایه — پیش‌فرض همان Docker Hub رسمی است و تولید و Compose
# آن را عوض نمی‌کنند. فقط CI مقدار public.ecr.aws/docker/library را می‌دهد:
# همان Docker Official Images با همان digest، بی محدودیت نرخ ناشناس Hub.
ARG BASE_REGISTRY=docker.io/library
FROM ${BASE_REGISTRY}/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
RUN corepack enable
# بدون TTY، pnpm پیش از پاک‌کردن node_modules تأیید می‌خواهد و بیلد
# با پیامی نامربوط می‌ایستد. آزموده شد.
ENV CI=true
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @labelmod/web

COPY apps/web apps/web
COPY integrations/woocommerce integrations/woocommerce
# `build` خودش اول tsc --noEmit می‌زند: بیلد تولید با خطای تایپ سبز
# نمی‌شود.
RUN pnpm --filter @labelmod/web build

# ---------------------------------------------------------------------
FROM ${BASE_REGISTRY}/caddy:2-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 AS runtime
RUN apk add --no-cache tzdata
ENV TZ=Asia/Tehran
COPY --from=build /app/apps/web/dist /srv
