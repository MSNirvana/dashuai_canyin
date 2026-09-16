import { useEffect, useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import Segmented from '../../components/segmented'
import {
  LEGAL_DOCS,
  LEGAL_EFFECTIVE_AT,
  LEGAL_OPERATOR,
  LEGAL_UPDATED_AT,
  legalDocOf,
  type LegalDocKey,
} from '../../constants/legal'
import './index.scss'

// 用户协议 / 隐私政策
//
// 一个页面承载两份文档，用路由参数 type=user|privacy 区分，顶部再用分段控件允许互切：
//   · 两个文档版式完全一致，拆成两个页面只会把同一套渲染逻辑复制两份；
//   · 从登录弹窗点《隐私政策》进来后，用户常常还想看看《用户协议》，顶部能直接切更顺。
//
// ⚠ 只认 type 的不合法值一律回落到用户协议（见 legalDocOf）—— 协议入口点进去白屏是合规事故。
export default function AgreementPage() {
  const router = useRouter()
  const [key, setKey] = useState<LegalDocKey>(legalDocOf(router.params?.type).key)
  const doc = legalDocOf(key)

  useEffect(() => {
    Taro.setNavigationBarTitle({ title: doc.navTitle })
  }, [doc.navTitle])

  return (
    <View className='agreement'>
      <View className='agreement__switch'>
        <Segmented
          options={LEGAL_DOCS.map((d) => ({ value: d.key, label: d.label }))}
          value={key}
          onChange={(v) => setKey(v === 'privacy' ? 'privacy' : 'user')}
        />
      </View>

      <View className='agreement__body'>
        <View className='agreement__head'>
          <Text className='agreement__title'>{doc.navTitle}</Text>
          <Text className='agreement__meta'>
            生效日期：{LEGAL_EFFECTIVE_AT}　·　更新日期：{LEGAL_UPDATED_AT}
          </Text>
        </View>

        <Text className='agreement__intro'>{doc.intro}</Text>

        {doc.sections.map((section) => (
          <View key={section.title} className='agreement__section'>
            <Text className='agreement__h'>{section.title}</Text>

            {section.paragraphs?.map((p) => (
              <Text key={p} className='agreement__p'>{p}</Text>
            ))}

            {section.list && (
              <View className='agreement__list'>
                {section.list.map((li) => (
                  <View key={li} className='agreement__li'>
                    <View className='agreement__dot' />
                    <Text className='agreement__litext'>{li}</Text>
                  </View>
                ))}
              </View>
            )}

            {section.blocks?.map((block) => (
              <View key={block.title} className='agreement__block'>
                <Text className='agreement__sub'>{block.title}</Text>
                {block.paragraphs?.map((p) => (
                  <Text key={p} className='agreement__p'>{p}</Text>
                ))}
                {block.list && (
                  <View className='agreement__list'>
                    {block.list.map((li) => (
                      <View key={li} className='agreement__li'>
                        <View className='agreement__dot' />
                        <Text className='agreement__litext'>{li}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))}

            {section.footer?.map((p) => (
              <Text key={p} className='agreement__p'>{p}</Text>
            ))}
          </View>
        ))}

        <View className='agreement__footer'>
          <Text className='agreement__footer-org'>{LEGAL_OPERATOR}</Text>
          <Text className='agreement__footer-note'>本页面内容自 {LEGAL_EFFECTIVE_AT} 起生效</Text>
        </View>
      </View>
    </View>
  )
}
