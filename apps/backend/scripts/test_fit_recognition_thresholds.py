import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('calibration',Path(__file__).with_name('fit-recognition-thresholds.py'))
calibration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calibration)

class CalibrationTest(unittest.TestCase):
    def test_class_split_is_disjoint_and_stratified(self):
        rows = [{'truth':i,'unknown':i>=8} for i in range(12) for _ in range(9)]
        fit, held = calibration.split_classes(rows)
        self.assertFalse(set(fit)&set(held))
        self.assertEqual(len(set(fit)&set(range(8))),4)
        self.assertEqual(len(set(held)&set(range(8,12))),2)
        self.assertEqual(sorted(fit+held),list(range(12)))
        self.assertEqual((fit,held),calibration.split_classes(list(reversed(rows))))

    def test_exact_boundary_sweep_maximizes_coverage(self):
        points = [(0.99,0.01,True),(0.95,0.2,True),(0.9,0.,False)]
        result = calibration.fit_match(points)
        self.assertEqual(result['matched'],2)
        self.assertEqual(result['correct'],2)
        self.assertEqual(result['threshold'],0.95)
        self.assertEqual(result['margin'],0.)

    def test_unknown_class_queries_count_as_false_matches(self):
        rows=[{'truth':1,'unknown':False,'scores':[[1,0.99],[2,0.8]]},
              {'truth':9,'unknown':True,'scores':[[1,0.98],[2,0.7]]}]
        points = calibration.query_points(rows)
        self.assertEqual([p[2] for p in points],[True,False])
        self.assertEqual(calibration.fit_match(points)['matched'],1)

    def test_floor_balances_known_and_unknown_without_affecting_match(self):
        rows=[{'truth':1,'unknown':False,'scores':[[1,0.8]]},
              {'truth':2,'unknown':False,'scores':[[1,0.7]]},
              {'truth':9,'unknown':True,'scores':[[1,0.65]]}]
        self.assertEqual(calibration.fit_floor(rows,0.9),0.7)

    def test_duplicates_exclude_all_views_of_query_photo(self):
        import numpy as np
        gallery={1:np.array([[1.,0.]]*7+[[0.,1.]]*7),
                 2:np.array([[-1.,0.]]*7+[[0.,-1.]]*7)}
        rows=calibration.duplicate_observations(gallery,[1,2])
        # Class 1 photo 0 must not score 1 against its own rotations/crops.
        same=[r for r in rows if r['truth']==1 and r['photo']==0 and r['candidate']==1]
        self.assertEqual(len(same),1)
        self.assertAlmostEqual(same[0]['score'],0.)

if __name__ == '__main__':
    unittest.main()
