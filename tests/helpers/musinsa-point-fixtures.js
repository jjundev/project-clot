export const AS_OF = Date.parse('2026-10-24T10:00:00Z');
export const CHECKED = '2026-10-24T09:00:00.000Z';
export function rawPointPolicy(overrides = {}) {
  return {meta:{result:'SUCCESS'},data:{goodsNo:2156295,isRestictedUsePoint:false,maxUsePointRate:0.07,
    isLimitedDc:true,isLimitedPoint:false,isOutlet:false,goodsPrice:{salePrice:263200,extraDiscountAmount:0},...overrides}};
}
export function pointPolicy(overrides = {}) {
  return {goodsNo:2156295,restricted:false,maxUseRate:0.07,observedSalePrice:263200,observedExtraDiscount:0,checkedAt:CHECKED,...overrides};
}
export function couponBasis(overrides = {}) {
  return {goodsNo:2156295,status:'ACTIVE',salePrice:263200,extraDiscount:0,couponPrice:248200,couponSource:'ESTIMATED',...overrides};
}
