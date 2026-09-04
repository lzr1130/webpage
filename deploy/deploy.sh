#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname -- "$script_dir")"
site_dir="/var/www/lizerun.top"
nginx_site="/etc/nginx/sites-available/lizerun.top"
dashboard_service="/etc/systemd/system/iprcapi-dashboard.service"

sudo install -d -m 0755 "$site_dir"
sudo rsync -a --delete --delete-excluded \
    --exclude='.git/' \
    --exclude='deploy/' \
    --exclude='__pycache__/' \
    --exclude='*.pyc' \
    "$repo_dir/" "$site_dir/"

sudo install -m 0644 "$script_dir/nginx.conf" "$nginx_site"
sudo install -m 0644 "$script_dir/iprcapi-dashboard.service" "$dashboard_service"
sudo ln -sfn "$nginx_site" /etc/nginx/sites-enabled/lizerun.top
if [[ -L /etc/nginx/sites-enabled/default ]]; then
    sudo unlink /etc/nginx/sites-enabled/default
fi

sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now iprcapi-dashboard
sudo systemctl restart iprcapi-dashboard
sudo systemctl reload nginx

echo "Deployed $repo_dir to $site_dir"
