import { PageHeader } from './components'
import {
  ICP_LICENSE,
  LEGAL_UPDATED_AT,
  OPERATOR,
  OPERATOR_ADDRESS,
  OPERATOR_CREDIT_CODE,
  REFUND_POLICY,
  SUPPORT_HOURS,
  SUPPORT_PHONE,
  SUPPORT_SLA,
} from './site-info'

/**
 * 基础服务规则 / 隐私协议。
 *
 * ★ 2026-10-23：原来的「经营者信息与联系渠道」是一块 `<Notice>待运营确认并补充…</Notice>`
 *   占位，退款条款也写着「需由运营补充确认」。微信支付 H5 支付权限**就是因为
 *   「网站中体验不到服务内容」被驳**的，官方规则第 1 条明确要求页面上
 *   「带有价格、有对应的售后服务、客诉解决的说明」——
 *   审核员点开这一页看到「待补充」，等于自己交出驳回理由。
 *   ⇒ 现在主体、信用代码、地址、客服电话、服务时间、答复时限、退款政策全部落到正文，
 *     取值统一来自 `site-info.ts`（改一处全站生效）。
 */
export function Rules() {
  return (
    <LegalPage
      title="基础服务规则"
      intro="本页面说明大帅餐饮助手网页服务的使用规则、退款与售后政策，以及经营主体与客诉渠道。"
    >
      <h2>一、服务说明</h2>
      <p>
        大帅餐饮助手（{OPERATOR} 运营）向餐饮经营者提供内容策划、文案生成、分镜脚本、素材处理、
        视频合成与账户服务。具体可用功能、额度与有效期以用户购买时服务端展示的套餐信息为准。
      </p>
      <h2>二、账户与登录</h2>
      <p>
        用户通过手机号验证码登录。未注册手机号首次验证通过后将自动创建账户。
        用户应妥善保管手机及验证码，不得出租、出借或转让账户。
      </p>
      <h2>三、会员与积分</h2>
      <p>
        会员权益、服务周期、赠送积分与加油包到账数量以购买页面展示和服务端订单记录为准。
        积分仅用于平台内约定服务，不等同于现金，不支持私下交易。
      </p>
      <h2>四、加油包购买条件</h2>
      <p>
        积分加油包仅向有效会员开放。会员失效后，是否可继续使用已购积分及具体消耗规则，
        以实际产品规则与购买时说明为准。
      </p>
      <h2>五、订单与支付</h2>
      <p>
        订单支付结果以服务端订单状态为准。若页面跳转、网络中断或支付结果显示异常，
        用户可在订单页面主动查询，不应重复下单。支付成功后权益自动到账，无需等待人工开通。
      </p>
      <h2>六、退款与售后</h2>
      {REFUND_POLICY.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <h2>七、内容规范</h2>
      <p>
        用户应确保上传素材及输入内容拥有合法使用权，不得利用服务制作或传播违法、侵权、
        虚假或损害他人合法权益的内容。
      </p>
      <h2>八、服务调整</h2>
      <p>
        因维护、升级、第三方服务异常等原因，部分功能可能暂时不可用。平台将根据实际情况恢复服务，
        并按适用规则处理受影响订单。
      </p>
      <h2>九、经营者信息与客诉渠道</h2>
      <ul className="legal-info">
        <li>经营者名称：{OPERATOR}</li>
        <li>统一社会信用代码：{OPERATOR_CREDIT_CODE}</li>
        <li>注册地址：{OPERATOR_ADDRESS}</li>
        <li>客服电话：{SUPPORT_PHONE}（{SUPPORT_HOURS}）</li>
        <li>投诉与售后：通过上述客服电话提出，{SUPPORT_SLA}</li>
        <li>备案号：{ICP_LICENSE}</li>
      </ul>
    </LegalPage>
  )
}

export function Privacy() {
  return (
    <LegalPage
      title="隐私协议"
      intro="本协议说明大帅餐饮助手网页端如何收集、使用、存储和保护你的个人信息，以及你享有哪些权利。"
    >
      <h2>一、我们收集的信息</h2>
      <p>
        为完成登录与账户识别，我们会处理手机号、验证码验证结果与账户标识；
        为提供会员和支付服务，我们会处理套餐选择、订单号、订单金额、支付状态、会员状态及积分信息。
      </p>
      <h2>二、信息的使用目的</h2>
      <p>
        上述信息用于创建和维护账户、完成身份验证、提供服务权益、展示订单、核对支付状态、
        保障交易安全以及处理用户咨询。
      </p>
      <h2>三、本地存储</h2>
      <p>
        网页端将访问令牌、刷新令牌及当前账号的待支付订单信息存放在 sessionStorage。
        关闭对应浏览器标签页后，会话级数据通常会被浏览器清除；退出登录时网页也会主动清除相关数据。
      </p>
      <h2>四、支付信息</h2>
      <p>
        支付由合规支付服务提供方处理。网页端不采集银行卡号或支付密码。
        支付成功与否以服务端向支付渠道核验后的订单状态为准。
      </p>
      <h2>五、信息共享与第三方</h2>
      <p>
        为实现短信验证、云服务、支付或内容处理，我们会向必要的服务提供方传递完成对应功能所必需的最少信息：
        腾讯云（对象存储与短信）、微信（登录与支付）、生成式人工智能服务商（生成文案与分镜）。
        我们不会出售你的个人信息。
      </p>
      <h2>六、保存与安全</h2>
      <p>
        信息在实现服务目的所需的期限内保存（账号信息在账号存续期间保存，订单与积分流水按法律法规及
        财务留存要求保存）。我们采取传输加密、访问权限最小化、操作日志记录等措施保护信息安全。
      </p>
      <h2>七、用户权利</h2>
      <p>
        用户可依法申请查询、更正、删除个人信息或注销账户。申请出口为下方第九节的客服渠道，
        我们核验身份后 {SUPPORT_SLA}。
      </p>
      <h2>八、未成年人</h2>
      <p>本服务主要面向餐饮经营者。若涉及未成年人个人信息，应由监护人同意并指导使用。</p>
      <h2>九、联系我们</h2>
      <ul className="legal-info">
        <li>个人信息处理者：{OPERATOR}</li>
        <li>注册地址：{OPERATOR_ADDRESS}</li>
        <li>联系渠道：客服电话 {SUPPORT_PHONE}（{SUPPORT_HOURS}）</li>
        <li>处理时限：{SUPPORT_SLA}</li>
        <li>备案号：{ICP_LICENSE}</li>
      </ul>
    </LegalPage>
  )
}

function LegalPage({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <section className="page-section legal-page">
      <div className="container narrow">
        <PageHeader eyebrow="服务说明" title={title} description={intro} />
        <article className="legal-card">
          <div className="legal-meta">最近更新：{LEGAL_UPDATED_AT}</div>
          {children}
        </article>
      </div>
    </section>
  )
}
