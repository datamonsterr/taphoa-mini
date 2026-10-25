/** Money digits only, as many as an int64 đồng amount safely allows. */
export const digitsOnly = (text: string) =>
  text.replace(/\D/g, '').slice(0, 12);
