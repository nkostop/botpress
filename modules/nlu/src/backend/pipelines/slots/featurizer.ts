import { MLToolkit } from 'botpress/sdk'
import _ from 'lodash'

import { computeQuantile } from '../../tools/math'
import { countAlpha, countNum, countSpecial } from '../../tools/strings'
import { SPACE } from '../../tools/token-utils'
import { LanguageProvider, Sequence, Token, Token2Vec } from '../../typings'
import { MAX_TFIDF, MIN_TFIDF, TfidfOutput } from '../intents/tfidf'
import { getClosestToken } from '../language/ft_featurizer'
import { sanitize } from '../language/sanitizer'

import { KMeansModel } from './crf_extractor'

type FeatureValue = string | number | boolean

export interface CRFFeature {
  name: string
  value: FeatureValue
  boost?: number
}

const TFIDF_WEIGHTS = ['low', 'medium', 'high']

// TODO remove this
export const computeBucket = (bucketSize: number) => (value: number, max: number) =>
  Math.min(bucketSize, Math.max(Math.ceil(bucketSize * (value / max)), 1))

// TODO REMOVE THIS
export const getFeaturesPairs = (vec0: string[], vec1: string[], features: string[]) => {
  const getPrefixAndFeat = (vec: string[], targetFeat: string) =>
    (vec.find(feat => feat.includes(targetFeat)) || '').replace(targetFeat, '').split('=')

  return features
    .map(targetFeat => {
      const [f0Prefix, f0Val] = getPrefixAndFeat(vec0, targetFeat)
      const [f1Prefix, f1Val] = getPrefixAndFeat(vec1, targetFeat)

      if (f0Val && f1Val) {
        return `${f0Prefix}|${f1Prefix}${targetFeat}=${f0Val}|${f1Val}`
      }
    })
    .filter(_.identity)
}

export function featToCRFsuiteAttr(prefix: string, feat: CRFFeature): string {
  return `${prefix}${feat.name}=${feat.value}:${feat.boost || 1}`
}

export function getFeatPairs(feats0: CRFFeature[], feats1: CRFFeature[], featNames: string[]): CRFFeature[] {
  const valueOf = (feat: CRFFeature | undefined): FeatureValue => _.get(feat, 'value', 'null')
  const boostOf = (feat: CRFFeature | undefined): number => _.get(feat, 'boost', 1)

  return featNames
    .map(targetFeat => {
      const f0 = feats0.find(f => f.name === targetFeat)
      const f1 = feats1.find(f => f.name === targetFeat)
      if (f0 || f1) {
        return {
          name: targetFeat,
          value: `${valueOf(f0)}|${valueOf(f1)}`,
          boost: Math.max(boostOf(f0), boostOf(f1))
        }
      }
    })
    .filter(_.identity)
}

export async function getWordWeight(
  tfidf: TfidfOutput, // this will move out in token
  token: Token,
  languageProvider: LanguageProvider, // this won't be necessary
  tokenVecCache: Token2Vec,
  language: string // this won't be necessary
): Promise<CRFFeature> {
  let value: string

  try {
    const strTok = token.cannonical.toLowerCase()
    let weight = tfidf['global'][strTok]
    if (!weight) {
      // TODO use vector in token instead
      const [wordVec] = await languageProvider.vectorize([strTok], language)
      const closestTok = await getClosestToken(strTok, Array.from(wordVec), tokenVecCache)
      weight = tfidf['global'][closestTok]
    }

    const tierce = computeQuantile(3, weight, MAX_TFIDF, MIN_TFIDF)
    value = TFIDF_WEIGHTS[tierce - 1]
  } catch (err) {
    value = 'low'
  }

  return {
    name: 'weight',
    value
  }
}

export async function getClusterFeat(
  token: Token,
  langugeModel: MLToolkit.FastText.Model, // this will move, use language provider instead
  kmeansModel: KMeansModel
): Promise<CRFFeature> {
  const vector = await langugeModel.queryWordVectors(token.cannonical.toLowerCase()) // TODO use token.wordVector instead
  const cluster = kmeansModel.nearest([vector])[0]
  return {
    name: 'cluster',
    value: cluster
  }
}

export function getWordFeat(token: Token, isPredict: boolean): CRFFeature | undefined {
  const boost = isPredict ? 3 : 1

  if (!token.matchedEntities.length) {
    return {
      name: 'word',
      value: token.cannonical.toLowerCase(),
      boost
    }
  }
}

export function getInVocabFeat(token: Token, vocab, intent: string): CRFFeature {
  const inVocab = !token.slot && (_.get(vocab, token.cannonical.toLowerCase(), []).includes(intent) as boolean)
  return {
    name: 'inVocab',
    value: inVocab
  }
}

export function getEntitiesFeats(token: Token, allowedEntities: string[], isPredict: boolean): CRFFeature[] {
  const boost = isPredict ? 3 : 1
  return _.chain(token.matchedEntities)
    .intersection(allowedEntities)
    .thru(ents => (ents.length ? ents : ['none']))
    .map(entity => ({
      name: 'entity',
      value: entity,
      boost
    }))
    .value()
}

export function getSpaceFeat(token: Token): CRFFeature {
  return {
    name: 'space',
    value: token.value.startsWith(SPACE)
  }
}

export function getNum(token: Token): CRFFeature {
  return {
    name: 'num',
    value: countNum(token.cannonical)
  }
}

export function getAlpha(token: Token): CRFFeature {
  return {
    name: 'alpha',
    value: countAlpha(token.cannonical)
  }
}

export function getSpecialChars(token: Token): CRFFeature {
  return {
    name: 'special',
    value: countSpecial(token.cannonical)
  }
}

export function getIntentFeature(intentName: string): CRFFeature {
  return {
    name: 'intent',
    value: sanitize(intentName.toLowerCase()).replace(/\s/, ''),
    boost: 100
  }
}

export function getTokenQuartile(seq: Sequence, tokIdx: number): CRFFeature {
  return {
    name: 'quartile',
    value: computeQuantile(4, tokIdx + 1, seq.tokens.length)
  }
}
