# 部署说明

网站源码位于 `/home/ubuntu/webpage`，Nginx 对外提供 `/var/www/lizerun.top` 中的静态文件。

修改网页后执行：

```bash
cd /home/ubuntu/webpage
./deploy/deploy.sh
```

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
