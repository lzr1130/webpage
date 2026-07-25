#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname -- "$script_dir")"
site_dir="/var/www/lizerun.top"
nginx_site="/etc/nginx/sites-available/lizerun.top"

sudo install -d -m 0755 "$site_dir"
sudo rsync -a --delete \
    --exclude='.git/' \
    --exclude='deploy/' \
    "$repo_dir/" "$site_dir/"

sudo install -m 0644 "$script_dir/nginx.conf" "$nginx_site"
sudo ln -sfn "$nginx_site" /etc/nginx/sites-enabled/lizerun.top
if [[ -L /etc/nginx/sites-enabled/default ]]; then
    sudo unlink /etc/nginx/sites-enabled/default
fi

sudo nginx -t
sudo systemctl reload nginx

echo "Deployed $repo_dir to $site_dir"
