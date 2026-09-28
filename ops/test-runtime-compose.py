"""کنترل قرارداد نقش برنامه بدون خواندن .env واقعی یا اجرای سرویس."""
import json
import os
from pathlib import Path
import subprocess
import sys

compose = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "docker-compose.prod.yml"
env = os.environ.copy()
for key in ("APP_DB_USER", "APP_DB_PASSWORD", "COMPOSE_ENV_FILES"):
    env.pop(key, None)
env.update(DB_PASSWORD="owner_fixture_only", SITE_ADDRESS="shop.example.com", ACME_EMAIL="ci@example.com")


def resolve(extra):
    return subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(compose),
                           "config", "--format", "json"], env={**env, **extra}, capture_output=True, text=True, check=False)


for extra in ({}, {"APP_DB_PASSWORD": ""}):
    result = resolve(extra)
    assert result.returncode != 0, "رمز app غایب یا خالی نباید به رمز مالک برگردد"
    assert "APP_DB_PASSWORD" in result.stderr

for username in (None, "custom_runtime"):
    extra = {"APP_DB_PASSWORD": "app_fixture_only"}
    if username:
        extra["APP_DB_USER"] = username
    result = resolve(extra)
    assert result.returncode == 0, "Compose با پیکربندی کامل باید معتبر باشد"
    services = json.loads(result.stdout)["services"]
    role = username or "labelmod_app"
    for name in ("api", "worker"):
        assert services[name]["environment"]["DATABASE_URL"] == f"postgres://{role}:app_fixture_only@db:5432/labelmod"
    scheduler = services["scheduler"]["environment"]
    assert scheduler["APP_ROLE"] == role
    assert scheduler["APP_PASSWORD"] == "app_fixture_only"
    assert scheduler["DATABASE_URL"] == "postgres://labelmod:owner_fixture_only@db:5432/labelmod"
    assert scheduler["MIGRATION_DATABASE_URL"] == scheduler["DATABASE_URL"]

print("قرارداد Compose: رمز مستقل اجباری، نقش محدود پیش‌فرض و اتصال مالک جدا تأیید شد")
