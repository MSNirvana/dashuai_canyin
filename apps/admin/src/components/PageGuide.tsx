import { useLocation } from 'react-router-dom'
import { InfoCircleIcon } from 'tdesign-icons-react'

type GuideItem = {
  term: string
  description: string
}

type PageGuideContent = {
  title: string
  intro: string
  items: GuideItem[]
}

const PAGE_GUIDES: Array<{ match: string; content: PageGuideContent }> = [
  {
    match: '/dashboard',
    content: {
      title: '先看这里：后台总览',
      intro: '这页用来快速看经营、积分、合成和 AI 的整体状态。数字异常时，再进入左侧对应页面处理。',
      items: [
        { term: '商家与内容', description: '看有多少商家、门店和作品。' },
        { term: 'AI 通道', description: '看 AI 服务是否可用，失败时会不会自动切换。' },
        { term: '运维告警', description: '看系统有没有需要尽快处理的问题。' },
      ],
    },
  },
  {
    match: '/ops-alerts',
    content: {
      title: '先看这里：运维告警',
      intro: '系统发现异常时会在这里留记录。先处理“严重”或一直重复出现的告警。',
      items: [
        { term: '未处理', description: '还没有确认过的告警。' },
        { term: '严重', description: '可能影响登录、生成或交付，需要优先看。' },
        { term: '告警代码', description: '系统内部的定位编号，联系开发时一起提供。' },
      ],
    },
  },
  {
    match: '/merchants',
    content: {
      title: '先看这里：商家管理',
      intro: '这里管理使用小程序的商家账号，可以查看状态、会员和积分。',
      items: [
        { term: '正常 / 禁用', description: '禁用后，商家不能继续使用后台服务。' },
        { term: '会员套餐', description: '商家当前的会员等级和有效期。' },
        { term: '积分余额', description: '商家生成文案、分镜和视频时使用的积分。' },
      ],
    },
  },
  {
    match: '/bean-packages',
    content: {
      title: '先看这里：加油包',
      intro: '加油包就是一次性购买的积分。商家买完后，可以用积分生成内容。',
      items: [
        { term: '积分', description: '平台内部的使用额度，不是现金。' },
        { term: '售价', description: '商家实际支付的金额，单位是元。' },
        { term: '赠送积分', description: '额外送给商家的积分，会和购买积分分开记录。' },
      ],
    },
  },
  {
    match: '/member-packages',
    content: {
      title: '先看这里：会员套餐',
      intro: '这里设置按月或按周期购买的会员服务。修改价格前，先确认线上是否已经有人购买。',
      items: [
        { term: '会员有效期', description: '商家可以使用会员权益的时间。' },
        { term: '赠送积分', description: '购买会员时额外发放的积分。' },
        { term: '上架 / 下架', description: '控制这个套餐是否出现在小程序购买页。' },
      ],
    },
  },
  {
    match: '/bean-ledger',
    content: {
      title: '先看这里：积分流水',
      intro: '每一笔积分变化都会记在这里。查账时按商家、类型和时间筛选。',
      items: [
        { term: '充值 / 赠送', description: '积分进入商家账户。' },
        { term: '冻结', description: '开始生成任务时先暂时占用，任务失败会退回。' },
        { term: '消耗 / 解冻', description: '任务成功扣除，或任务失败释放之前占用的积分。' },
      ],
    },
  },
  {
    match: '/render-tasks',
    content: {
      title: '先看这里：合成任务',
      intro: '这里查看视频合成进度。一般只需要关注排队太久、失败和重复失败的任务。',
      items: [
        { term: '排队中', description: '任务已经创建，等待合成程序处理。' },
        { term: '处理中', description: '正在配音、字幕或视频合成。' },
        { term: '失败', description: '打开任务详情看原因，确认素材和服务状态后再重试。' },
      ],
    },
  },
  {
    match: '/premium-orders',
    content: {
      title: '先看这里：精品接单',
      intro: '这里处理需要人工剪辑或人工交付的作品订单。',
      items: [
        { term: '待接单', description: '订单已支付，等待工作人员接手。' },
        { term: '剪辑中', description: '已经有人处理，完成后上传交付文件。' },
        { term: '交付', description: '把最终视频发给商家，确认后订单才算完成。' },
      ],
    },
  },
  {
    match: '/ai/providers',
    content: {
      title: '先看这里：AI 通道',
      intro: '通道就是连接外部 AI 服务的入口。一个通道不可用时，系统可以尝试其他通道。',
      items: [
        { term: '供应商', description: '提供 AI 服务的公司或平台。' },
        { term: 'API Key', description: '调用服务的密钥，只显示部分内容，不能对外发送。' },
        { term: '启用 / 停用', description: '控制系统是否继续使用这个通道。' },
      ],
    },
  },
  {
    match: '/ai/models',
    content: {
      title: '先看这里：AI 模型',
      intro: '模型是通道里面具体负责工作的 AI。不同模型适合文字、图片、视频或语音。',
      items: [
        { term: '能力类型', description: '模型能做什么，例如文本、图像、视频和语音。' },
        { term: '默认模型', description: '某个功能正常情况下优先使用的模型。' },
        { term: '备用模型', description: '默认模型失败时，系统按顺序尝试的模型。' },
      ],
    },
  },
  {
    match: '/ai/scenes',
    content: {
      title: '先看这里：AI 场景',
      intro: '场景就是一个具体功能的 AI 规则，例如写口播、生成分镜或生成发布文案。',
      items: [
        { term: '提示词', description: '告诉 AI 应该怎么写、不能写什么的说明。' },
        { term: '兜底文案', description: 'AI 暂时不可用时，系统返回的保底内容。' },
        { term: '价格 / 积分', description: '每调用一次这个功能要扣多少积分。' },
      ],
    },
  },
  {
    match: '/ai/call-logs',
    content: {
      title: '先看这里：AI 调用日志',
      intro: '这里记录每次 AI 请求，适合排查“为什么没生成、用了哪个模型、扣了多少积分”。',
      items: [
        { term: '成功', description: 'AI 正常返回了结果。' },
        { term: '降级', description: '首选模型失败，系统改用了备用模型。' },
        { term: '超时 / 失败', description: '服务响应太慢或没有返回有效内容。' },
      ],
    },
  },
  {
    match: '/shot-library',
    content: {
      title: '先看这里：镜头库',
      intro: '镜头库是给分镜使用的拍摄动作模板。写得越清楚，测试人员越容易照着拍。',
      items: [
        { term: '镜头类型', description: '例如口播、环境、特写和制作过程。' },
        { term: '景别', description: '画面远近，例如全景、中景、近景和特写。' },
        { term: '镜头代码', description: '系统匹配镜头时使用的唯一编号，不建议随意改。' },
      ],
    },
  },
  {
    match: '/works',
    content: {
      title: '先看这里：优秀作品',
      intro: '这里管理小程序里展示的优秀案例。发布前先确认视频、标题和封面都正常。',
      items: [
        { term: '上架 / 下架', description: '控制作品是否展示给小程序用户。' },
        { term: '文案类型', description: '流量型、人设型、干货型、产品型和种草型。' },
        { term: '分镜复杂度', description: '决定分镜大致有几个镜头，不代表一定要拍满。' },
      ],
    },
  },
  {
    match: '/home-carousel',
    content: {
      title: '先看这里：首页轮播图',
      intro: '这里管理小程序首页顶部的轮播图片。上传图片后，点确认并保存才会生效。',
      items: [
        { term: '排序', description: '数字越小越靠前。' },
        { term: '跳转', description: '用户点击图片后要去的页面，也可以设置为只展示。' },
        { term: '启用', description: '只有启用的图片才会出现在小程序首页。' },
      ],
    },
  },
  {
    match: '/home-slogan-banner',
    content: {
      title: '先看这里：首页口号图',
      intro: '这里管理首页的品牌口号图。替换图片后记得点击保存。',
      items: [
        { term: '预览', description: '当前已经保存、正在使用的图片。' },
        { term: '未保存改动', description: '表示你刚上传的图片还没有正式生效。' },
        { term: '图片地址', description: '系统保存图片的位置，一般不用手动修改。' },
      ],
    },
  },
  {
    match: '/tutorials',
    content: {
      title: '先看这里：教学中心',
      intro: '这里发布给商家看的教程。建议标题直接写清楚“学什么、解决什么问题”。',
      items: [
        { term: '已上架 / 已下架', description: '上架后用户才能在小程序里看到。' },
        { term: '分类', description: '拍摄、剪辑、运营或使用手册，方便用户筛选。' },
        { term: '封面和视频', description: '封面负责让人想点开，视频负责讲清楚。' },
      ],
    },
  },
  {
    match: '/settings',
    content: {
      title: '先看这里：系统设置',
      intro: '这里是后台的基础配置。不了解用途时不要随意修改，改动前先记录原值。',
      items: [
        { term: '文本', description: '给系统使用的普通文字配置。' },
        { term: '数字', description: '数量、时长或金额等数字配置。' },
        { term: '开关', description: '控制某项功能是否打开。' },
      ],
    },
  },
  {
    match: '/tts-providers',
    content: {
      title: '先看这里：TTS 供应商',
      intro: 'TTS 就是“文字转语音”。这里设置视频口播使用的语音服务。',
      items: [
        { term: '供应商', description: '提供文字转语音服务的平台。' },
        { term: '音色 ID', description: '决定声音像谁、用什么语气说话。' },
        { term: '启用 / 停用', description: '控制合成视频时是否使用这家语音服务。' },
      ],
    },
  },
]

function guideForPath(pathname: string): PageGuideContent | null {
  return PAGE_GUIDES.find(({ match }) => pathname === match || pathname.startsWith(`${match}/`))?.content ?? null
}

export default function PageGuide() {
  const { pathname } = useLocation()
  const content = guideForPath(pathname)
  if (!content) return null

  return (
    <details className="page-guide">
      <summary className="page-guide__summary">
        <span className="page-guide__summary-main">
          <InfoCircleIcon />
          <span>{content.title}</span>
        </span>
        <span className="page-guide__summary-action">点击查看</span>
      </summary>
      <div className="page-guide__body">
        <p>{content.intro}</p>
        <div className="page-guide__items">
          {content.items.map((item) => (
            <div className="page-guide__item" key={item.term}>
              <strong>{item.term}</strong>
              <span>{item.description}</span>
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}
