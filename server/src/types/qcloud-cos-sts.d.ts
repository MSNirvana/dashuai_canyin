// qcloud-cos-sts （腾讯云 STS 临时密钥）无官方类型声明，这里给最小 any 声明
declare module 'qcloud-cos-sts' {
  const STS: {
    getCredential: (
      options: Record<string, unknown>,
      callback: (err: Error | null, data: unknown) => void,
    ) => void
  }
  export default STS
}
