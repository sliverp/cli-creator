# StartCpuExpand

用于手动扩容云数据库实例 CPU。

## 接口描述

POST / HTTP/1.1
Host: cdb.tencentcloudapi.com
Content-Type: application/json
X-TC-Action: StartCpuExpand
<公共请求参数>

## 请求参数

| 参数名 | 类型 | 必选 | 说明 |
| --- | --- | --- | --- |
| InstanceId | string | 是 | 实例 ID |
| Type | string | 是 | 扩容类型 |
| ExpandCpu | number | 是 | 扩容 CPU 数 |

## 请求示例

```http
POST / HTTP/1.1
Host: cdb.tencentcloudapi.com
Content-Type: application/json
X-TC-Action: StartCpuExpand
```

```json
{
  "InstanceId": "cdb-himitj11",
  "Type": "manual",
  "ExpandCpu": 4
}
```

## 返回示例

```json
{
  "Response": {
    "AsyncRequestId": "841592f6-dd318344-aea19230-38912726",
    "RequestId": "6EF60BEC-0242-43AF-BB20-270359FB54A7"
  }
}
```
