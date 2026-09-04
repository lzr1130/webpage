# New API 额度看板

页面地址：`https://lizerun.top/iprcapi/`

后端只在 `127.0.0.1:18765` 监听，由 Nginx 代理。上游 API Key 仅由后端从环境变量、`~/.newapi_env` 或 `~/.bashrc` 中读取，不会传给浏览器。

页面无需登录即可查看，因此额度、Token 名称、模型清单与脱敏后的调用统计属于公开信息；API Key、请求内容、IP、用户及渠道字段不会返回给浏览器。

额度查询和手动刷新最短间隔为 1 秒；网页处于可见状态时每 30 秒自动刷新，后台标签页停止刷新，重新进入页面时补一次刷新。日志缓存 5 秒，模型、定价与服务配置缓存 5 分钟。

需要的配置：

```bash
export NEW_API_KEY='sk-...'
export NEW_API_HOST='http://43.143.241.66:18319'
export NEW_API_BASE_URL='http://43.143.241.66:18319/v1'
```

部署或更新：

```bash
cd /home/ubuntu/webpage
./deploy/deploy.sh
```

服务检查：

```bash
systemctl status iprcapi-dashboard
journalctl -u iprcapi-dashboard -n 100 --no-pager
```

当前读取的只读接口：

- `/api/usage/token/`：Token 名称、总额度、已用、可用、有效期、模型限制。
- `/v1/models`：当前 Key 实际可用的模型。
- `/api/pricing`：模型倍率、缓存倍率、支持协议、供应商与分组。
- `/api/log/token`：当前 Key 最近的调用记录与衍生统计。
- `/api/status`：实例名称、版本、额度换算单位等非敏感配置。
