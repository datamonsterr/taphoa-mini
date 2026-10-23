/** Pure cart math. Money is an integer number of đồng (VND has no minor unit). */
export type CartLine = {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
};

export type NewCartLine = Omit<CartLine, 'quantity'>;

export function addLine(lines: CartLine[], item: NewCartLine): CartLine[] {
  const existing = lines.find((l) => l.productId === item.productId);
  if (!existing) return [...lines, { ...item, quantity: 1 }];
  return lines.map((l) =>
    l.productId === item.productId ? { ...l, quantity: l.quantity + 1 } : l,
  );
}

export function removeLine(lines: CartLine[], productId: string): CartLine[] {
  return lines.filter((l) => l.productId !== productId);
}

export function totalDong(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}
