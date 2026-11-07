import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / 'dataset_export.py'
spec = importlib.util.spec_from_file_location('dataset_export', path)
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class RecognitionSelectionTest(unittest.TestCase):
    def test_references_from_any_query_scan_are_held_out(self):
        refs = [{'product_id': 'p', 'image_id': 'same', 'key': 'a'},
                {'product_id': 'p', 'image_id': 'other', 'key': 'b'}]
        queries = [{'product_id': 'p', 'scan_image_id': 'same', 'id': 'q', 'key': 'c'}]
        chosen_refs, chosen_queries = export.select_recognition(refs, queries, 1, 5)
        self.assertEqual([r['image_id'] for r in chosen_refs], ['other'])
        self.assertEqual(len(chosen_queries), 1)

    def test_reference_crop_from_query_scan_is_held_out(self):
        refs = [{'product_id': 'p', 'image_id': 'crop', 'source_scan_images': ['scan'], 'key': 'a'},
                {'product_id': 'p', 'image_id': 'ref', 'source_scan_images': [], 'key': 'b'}]
        queries = [{'product_id': 'p', 'scan_image_id': 'scan', 'id': 'q', 'key': 'c'}]
        chosen, _ = export.select_recognition(refs, queries, 1, 5)
        self.assertEqual([r['image_id'] for r in chosen], ['ref'])

    def test_minimum_and_maximum_apply_to_queries(self):
        refs = [{'product_id': 'p', 'image_id': 'ref', 'key': 'a'}]
        queries = [{'product_id': 'p', 'scan_image_id': str(i), 'id': str(i), 'key': str(i)} for i in range(3)]
        self.assertEqual(len(export.select_recognition(refs, queries, 2, 2)[1]), 2)
        self.assertEqual(export.select_recognition(refs, queries[:1], 2, 2), ([], []))


class VoiceSelectionTest(unittest.TestCase):
    def test_corrections_and_unreviewed_provenance(self):
        draft = {'lines': [{'id': 'l', 'spoken': 'coca', 'product': {'id': 'p', 'name': 'Coca'}, 'quantity': 1, 'unit_price': 10000, 'price_source': 'catalog'}], 'payment_method': 'cash'}
        row = {'id': 'v', 'transcript': 'coca', 'language': 'vi', 'draft': draft, 'corrections': [{'line_id': 'l', 'quantity': 2}], 'product_names': {}}
        case = export.voice_case(row)
        self.assertEqual(case['review_status'], 'unreviewed')
        self.assertEqual(case['original_draft'], draft)
        self.assertEqual(case['lines'][0]['quantity'], 2)
        self.assertIsNone(case['lines'][0]['unit_price'])


if __name__ == '__main__':
    unittest.main()
