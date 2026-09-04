# 部署说明

网站源码位于 `/home/ubuntu/webpage`，Nginx 对外提供 `/var/www/lizerun.top` 中的静态文件。

修改网页后执行：

```bash
cd /home/ubuntu/webpage
./deploy/deploy.sh
```

`/iprcapi/` 还会安装并重启本机只读查询服务 `iprcapi-dashboard.service`。
该服务从 `/home/ubuntu/.newapi_env` 或 `/home/ubuntu/.bashrc` 读取
`NEW_API_KEY`、`NEW_API_HOST` 和 `NEW_API_BASE_URL`。

当前 Nginx 使用手动上传的证书：

```bash
/etc/nginx/ssl/lizerun.top/fullchain.pem
/etc/nginx/ssl/lizerun.top/private.key
```

替换证书后检查配置并重新加载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```
