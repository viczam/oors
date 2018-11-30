import { updateOne } from '../../../../../../../../packages/oors-mongodb/build/graphql/createResolvers';
import {
  compose,
  withArgs,
  withJSONSchema,
} from '../../../../../../../../packages/oors-graphql/build/decorators';
import PostRepository from '../../../repositories/Post';

export default compose(
  withJSONSchema({
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: PostRepository.statuses, // making sure we only accept valid statuses
          },
          categoryId: {
            isObjectId: true,
          },
        },
      },
    },
  }),
  withArgs((_, { input, id }, { user, loaders }, info, { resolve }) => ({
    input: {
      ...input,
      [id ? 'updatedBy' : 'createdBy']: user._id, // user stamps
    },
    // if we have a categoryId, we need to make sure it points to an existing database entry
    category: input.categoryId
      ? resolve(loaders.oorsBlogCategories.findById.load(input.categoryId))
      : null,
  })),
)(
  updateOne({
    repositoryName: 'oors.blog.Post',
    // you can only delete and update your own posts posts
    canUpdate: (user, item) => user._id.toString() === item.createdBy.toString(),
  }),
);
