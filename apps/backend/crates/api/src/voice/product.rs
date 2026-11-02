#[cfg(test)]
mod tests {
    use super::fallback;

    #[test]
    fn vietnamese_product_phrases() {
        let cases = [
            ("Mì Hảo Hảo tôm chua cay năm nghìn", "Mì Hảo Hảo tôm chua cay", Some(5000), None),
            ("mì Hảo Hảo 5k", "mì Hảo Hảo", Some(5000), None),
            ("sữa mười hai nghìn rưỡi", "sữa", Some(12500), None),
            ("cà phê hai mươi lăm ngàn", "cà phê", Some(25000), None),
            ("nước suối Lavie 500ml, tám nghìn rưỡi một chai", "nước suối Lavie 500ml", Some(8500), Some("chai")),
            ("bánh 10k một gói", "bánh", Some(10000), Some("gói")),
            ("bia 20k một lon", "bia", Some(20000), Some("lon")),
            ("sữa 30k một hộp", "sữa", Some(30000), Some("hộp")),
            ("bút 4k một cái", "bút", Some(4000), Some("cái")),
            ("gạo 25k một kg", "gạo", Some(25000), Some("kg")),
            ("dầu ăn một triệu rưỡi", "dầu ăn", Some(1500000), None),
            ("kẹo ba nghìn", "kẹo", Some(3000), None),
            ("trà 12k", "trà", Some(12000), None),
            ("nước mắm", "nước mắm", None, None),
            ("sữa 500ml", "sữa 500ml", None, None),
            ("gạo ST25", "gạo ST25", None, None),
        ];
        for (spoken, name, price, unit) in cases {
            let draft = fallback(spoken);
            assert_eq!((draft.name.as_str(), draft.price, draft.unit.as_deref()), (name, price, unit), "{spoken}");
        }
    }
}
