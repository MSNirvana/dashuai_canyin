import { areaList } from '@vant/area-data'

export interface AreaOption {
  code: string
  name: string
}

const sortCodes = (list: Record<string, string>, prefix: string) =>
  Object.keys(list)
    .filter((code) => code.startsWith(prefix))
    .sort()
    .map((code) => ({ code, name: list[code] }))

export const provinceOptions: AreaOption[] = Object.keys(areaList.province_list)
  .sort()
  .map((code) => ({ code, name: areaList.province_list[code] }))

export function cityOptions(provinceCode: string): AreaOption[] {
  return sortCodes(areaList.city_list, provinceCode.slice(0, 2))
}

export function districtOptions(cityCode: string): AreaOption[] {
  return sortCodes(areaList.county_list, cityCode.slice(0, 4))
}

const normalizedName = (name: string) => name.replace(/特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市$/g, '')

const namesMatch = (left: string, right: string) =>
  left === right || (!!left && !!right && normalizedName(left) === normalizedName(right))

export function resolveAreaNames(input: { province?: string | null; city?: string | null; district?: string | null }) {
  const provinceName = input.province ?? ''
  const cityName = input.city ?? ''
  const districtName = input.district ?? ''

  let province = provinceOptions.find((item) => namesMatch(item.name, provinceName))
  let city: AreaOption | undefined

  if (province) city = cityOptions(province.code).find((item) => namesMatch(item.name, cityName))
  if (!city && cityName) {
    const matches = provinceOptions.flatMap((item) =>
      cityOptions(item.code)
        .filter((candidate) => namesMatch(candidate.name, cityName))
        .map((candidate) => ({ province: item, city: candidate })),
    )
    if (matches.length === 1) {
      province = matches[0].province
      city = matches[0].city
    }
  }

  const district = city
    ? districtOptions(city.code).find((item) => namesMatch(item.name, districtName))
    : undefined

  return {
    province: province?.name ?? provinceName,
    city: city?.name ?? cityName,
    district: district?.name ?? districtName,
  }
}
