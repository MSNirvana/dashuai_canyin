// 环境变量加载（dotenv）。开发期从 .env 读取；生产由容器注入，不依赖文件
import 'dotenv/config'
import { validateProductionConfig } from './lib/config.js'
validateProductionConfig()
