#!/usr/bin/env python3
"""Reproduce B5 dynamic INT8 challenger with onnxruntime==1.23.2 (CPU)."""
import sys
import onnxruntime
from onnxruntime.quantization import QuantType, quantize_dynamic

if onnxruntime.__version__ != '1.23.2':
    raise SystemExit('requires onnxruntime==1.23.2')
source, destination = sys.argv[1:]
# Patch projection Conv stays FP32: dynamic ConvInteger is not universally supported.
# Per-channel signed weights and reduced range avoid AVX2 saturation on the target CPU.
quantize_dynamic(source, destination, per_channel=True, reduce_range=True,
                 weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul', 'Gemm'])
