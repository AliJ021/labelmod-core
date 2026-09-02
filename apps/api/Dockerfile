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
FROM node:22-alpine AS deps

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
FROM node:22-alpine AS runtime

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
USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# tini تا SIGTERM واقعاً به Node برسد و Shutdown تمیز اجرا شود.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
