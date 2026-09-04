# New API 额度看板

页面地址：`https://lizerun.top/iprcapi/`

后端只在 `127.0.0.1:18765` 监听，由 Nginx 代理。上游 API Key 仅由后端从环境变量、`~/.newapi_env` 或 `~/.bashrc` 中读取，不会传给浏览器。

页面无需登录即可查看，因此额度、Token 名称、模型清单与脱敏后的调用统计属于公开信息；API Key、请求内容、IP、用户及渠道字段不会返回给浏览器。

服务器后台独立更新数据，网页请求只读取服务器缓存，刷新或同时打开多个页面都不会触发上游请求。额度与调用日志各每 5 分钟更新一次；两者共用“20 分钟 20 次”的 Critical 限流时，服务器使用持久化滑动窗口将总请求数硬限制为最多 16 次，并保证相邻请求至少间隔 70 秒，收到 `429` 后遵守上游 `Retry-After`。模型、定价和服务配置每 6 小时更新一次。全部数据、各数据源更新时间和限流状态保存在服务器的 `source-cache.json`，重启后继续生效；网页只显示服务器缓存的数据更新时间。

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
- `/api/log/token`：当前 Key 最近最多 1000 条调用记录与衍生统计（上游接口自身的返回上限）。
- `/api/status`：实例名称、版本、额度换算单位等非敏感配置。
