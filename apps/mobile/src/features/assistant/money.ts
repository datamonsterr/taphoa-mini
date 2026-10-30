/**
 * The model and the tool summaries write money as "44.000 ₫"; the rest of the app and board 17
 * write "44.000đ". Joins the sign to the number.
 */
export const plainMoney = (text: string): string =>
  text.replace(/(\d)[\s\u00a0\u202f]*₫/g, '$1đ');
